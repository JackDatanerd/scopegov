// app/(app)/invoices/page.tsx
// Phase 4a: workspace-wide invoice registry, mirrors /sow's pattern.
// Phase 4: portfolio reconciliation strip for VIEW_ALL_PROJECTS users.

import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatDate, formatCurrency, invoiceStatusLabel, invoicePill } from '@/lib/utils/format'

export const metadata = { title: 'Invoices' }

export default async function InvoicesPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (!hasPermission(session, 'VIEW_FINANCIALS')) redirect('/dashboard')

  const service = createServiceClient()
  const isSoloCapped = session.planTier === 'solo'
  const limit = isSoloCapped ? 10 : 500

  const { data: workspace } = await (service as any)
    .from('workspaces').select('currency').eq('id', session.workspaceId).single()
  const wsCurrency = workspace?.currency || 'USD'

  // FIX (section-12 audit): this page's own header comment says it
  // "mirrors /sow's pattern" — and it did, bug included: no project-
  // membership filtering at all, gated only on VIEW_FINANCIALS. Since
  // VIEW_FINANCIALS doesn't imply VIEW_ALL_PROJECTS, any member with
  // financial visibility on their own assigned projects could see every
  // invoice — every client name and dollar figure — workspace-wide
  // through this one page. Fixed the same way /sow/page.tsx was fixed.
  const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')
  let allowedProjectIds: string[] | null = null
  if (!canViewAll) {
    // FIX (fix round, section-11/12 finding): same workspace-scoping gap
    // as /api/approvals and /api/invoices — mirrors canReadProject's own
    // join pattern (lib/utils/project-access.ts) instead of filtering on
    // workspace_members.user_id alone.
    const { data: ids } = await (service as any)
      .from('project_members')
      .select('project_id, projects!inner(workspace_id), workspace_members!inner(user_id)')
      .eq('projects.workspace_id', session.workspaceId)
      .eq('workspace_members.user_id', session.id)
    allowedProjectIds = (ids || []).map((r: any) => r.project_id)
  }

  let invoicesQuery = (service as any)
    .from('invoices')
    .select(`id, invoice_number, title, amount, amount_paid, currency, status, due_date, sent_at, paid_at, created_at, disputed_at,
      projects(id, name, clients(name))`)
    .eq('workspace_id', session.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (allowedProjectIds !== null) invoicesQuery = invoicesQuery.in('project_id', allowedProjectIds)

  const { data: invoices = [], error: invErr } = await invoicesQuery

  if (invErr) console.error('Invoices registry error:', invErr)
  const safeInvoices = invoices || []

  // FIX (section-12 audit, flagship finding): this page's own header
  // comment says it "mirrors /sow's pattern" — and it did, right down to
  // the bug /sow/page.tsx already found and fixed in itself: "Total
  // invoices"/"Outstanding"/"Overdue" were computed from `safeInvoices`,
  // which is capped by `limit` (10 for solo tier). For any solo-tier
  // workspace with more than 10 invoices ever created, every number in
  // this summary strip silently undercounted — with nothing but the
  // generic "showing the 10 most recent" banner (which reads as being
  // about the table, not these figures) to suggest anything was missing.
  // Use exact counts instead, same as /sow's fix, scoped to the same
  // allowedProjectIds filter as the list query above.
  const workspaceId = session.workspaceId
  function countQuery(statuses?: string[]) {
    let q = (service as any).from('invoices').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
    if (allowedProjectIds !== null) q = q.in('project_id', allowedProjectIds)
    if (statuses) q = q.in('status', statuses)
    return q
  }
  const [{ count: totalCount }, { count: outstandingCount }, { count: overdueCount }] = await Promise.all([
    countQuery(),
    countQuery(['sent', 'partially_paid', 'overdue']),
    countQuery(['overdue']),
  ])

  // Same row-cap problem applies to "Collected" — it needs the true
  // all-time sum per currency, not just the sum over the first `limit`
  // rows. A second, unlimited query for just the three columns this
  // needs (never rendered as a table, so no cap-related UX concern the
  // way the row list has) rather than trying to aggregate in SQL through
  // the query builder.
  //
  // Grouped by currency rather than summed into one blended figure under
  // the workspace's default currency — this app explicitly supports
  // per-project currency (see e.g. the approval-workflow threshold
  // currency fix), so a single sum across invoices in different
  // currencies would be adding unlike units together, not a rounding
  // error.
  let paidRowsQuery = (service as any)
    .from('invoices').select('currency, amount_paid, status')
    .eq('workspace_id', workspaceId)
  if (allowedProjectIds !== null) paidRowsQuery = paidRowsQuery.in('project_id', allowedProjectIds)
  const { data: paidRows } = await paidRowsQuery

  const paidByCurrency = new Map<string, number>()
  for (const i of (paidRows || [])) {
    if (i.status === 'draft' || i.status === 'void') continue
    const cur = i.currency || wsCurrency
    paidByCurrency.set(cur, (paidByCurrency.get(cur) || 0) + Number(i.amount_paid || 0))
  }

  const stats = {
    total:       totalCount       ?? safeInvoices.length,
    outstanding: outstandingCount ?? safeInvoices.filter((i: any) => ['sent', 'partially_paid', 'overdue'].includes(i.status)).length,
    overdue:     overdueCount     ?? safeInvoices.filter((i: any) => i.status === 'overdue').length,
  }

  // Phase 4: portfolio reconciliation, only for members who can see the whole workspace.
  // FIX (section-12 audit): same cross-currency summation bug as
  // stats.paidValue above — snapshots are per-project and each project
  // carries its own currency, but this summed contracted/invoiced/paid/
  // at-risk values across every project in the workspace and displayed
  // the blended total under one currency label. Join each snapshot's
  // project currency and group the rollup by it.
  let portfolioByCurrency = new Map<string, { contractedValue: number; invoicedToDate: number; paidToDate: number; atRiskValue: number }>()
  if (hasPermission(session, 'VIEW_ALL_PROJECTS')) {
    const { data: rows } = await (service as any)
      .from('contract_reconciliation_snapshots')
      .select('project_id, contracted_value, invoiced_to_date, paid_to_date, at_risk_value, snapshot_date, projects(currency)')
      .eq('workspace_id', session.workspaceId)
      .order('snapshot_date', { ascending: true })
    const latestByProject = new Map<string, any>()
    for (const r of (rows || [])) latestByProject.set(r.project_id, r)
    for (const r of Array.from(latestByProject.values())) {
      const cur = r.projects?.currency || wsCurrency
      const acc = portfolioByCurrency.get(cur) || { contractedValue: 0, invoicedToDate: 0, paidToDate: 0, atRiskValue: 0 }
      portfolioByCurrency.set(cur, {
        contractedValue: acc.contractedValue + (r.contracted_value || 0),
        invoicedToDate:  acc.invoicedToDate + (r.invoiced_to_date || 0),
        paidToDate:      acc.paidToDate + (r.paid_to_date || 0),
        atRiskValue:     acc.atRiskValue + (r.at_risk_value || 0),
      })
    }
  }

  return (
    <div className="page" style={{ maxWidth: 1040 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Invoices</h1>
          <p className="page-sub">Client invoicing across your workspace — ScopeGov tracks status, your agency collects the payment</p>
        </div>
      </div>

      {isSoloCapped && (
        <div className="banner banner-info" style={{ marginBottom: 20 }}>
          <span>Showing the 10 most recent invoices. <strong>Upgrade to Starter or above</strong> to see the full history.</span>
          <Link href="/settings?tab=billing">
            <button className="btn btn-primary btn-sm">Upgrade</button>
          </Link>
        </div>
      )}

      <div className="mstrip" style={{ marginBottom: 22 }}>
        <div className="mc">
          <div className="mc-lbl">Total invoices</div>
          <div className="mc-val">{stats.total}</div>
          <div className="mc-sub">All statuses</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Outstanding</div>
          <div className="mc-val gold">{stats.outstanding}</div>
          <div className="mc-sub">Awaiting payment</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Overdue</div>
          <div className="mc-val red">{stats.overdue}</div>
          <div className="mc-sub">Past due date</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Collected</div>
          {/* FIX (section-12 audit): one figure per currency actually in
              use, rather than a single blended sum mislabeled with the
              workspace's default currency. Most agencies only ever see
              one line here — this only changes anything for a workspace
              that genuinely has invoices in more than one currency. */}
          {paidByCurrency.size === 0 ? (
            <div className="mc-val green">{formatCurrency(0, wsCurrency, true)}</div>
          ) : (
            Array.from(paidByCurrency.entries()).map(([cur, amount], i) => (
              <div key={cur} className="mc-val green" style={i > 0 ? { fontSize: '0.7em', marginTop: 2 } : undefined}>
                {formatCurrency(amount, cur, true)}
              </div>
            ))
          )}
          <div className="mc-sub">All-time</div>
        </div>
      </div>

      {portfolioByCurrency.size > 0 && (
        <div className="surface surface-p" style={{ marginBottom: 22 }}>
          <div className="sec-title" style={{ marginBottom: 10 }}>Portfolio reconciliation</div>
          {Array.from(portfolioByCurrency.entries())
            .filter(([, p]) => p.contractedValue > 0)
            .map(([cur, portfolio], i, arr) => (
              <div key={cur} style={{ marginBottom: i < arr.length - 1 ? 16 : 0 }}>
                {/* Currency sub-label only needed once there's more than
                    one — keeps the common single-currency case looking
                    exactly as it did before this fix. */}
                {arr.length > 1 && (
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 }}>{cur}</div>
                )}
                <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                  <MetricBlock label="Contracted" value={formatCurrency(portfolio.contractedValue, cur)} />
                  <MetricBlock label="Invoiced" value={formatCurrency(portfolio.invoicedToDate, cur)} color="var(--blue)" />
                  <MetricBlock label="Paid" value={formatCurrency(portfolio.paidToDate, cur)} color="var(--green)" />
                  {portfolio.atRiskValue > 0 && <MetricBlock label="At risk" value={formatCurrency(portfolio.atRiskValue, cur)} color="var(--gold)" />}
                </div>
              </div>
            ))}
        </div>
      )}

      {!safeInvoices.length ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-receipt-2 empty-state-icon" />
            <p className="empty-state-title">No invoices yet</p>
            <p className="empty-state-sub">Create an invoice from a project&apos;s Billing tab, against a milestone, signed SOW, or accepted change order.</p>
          </div>
        </div>
      ) : (
        <div className="surface" style={{ overflow: 'hidden' }}>
          <table className="gov-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>No.</th>
                <th>Project</th>
                <th>Client</th>
                <th>Title</th>
                <th>Status</th>
                <th>Due</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {safeInvoices.map((inv: any) => (
                <tr key={inv.id}>
                  <td className="td-mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{inv.invoice_number || '—'}</td>
                  <td>
                    <Link href={`/projects/${inv.projects?.id}?tab=billing`}>
                      <div className="td-primary">{inv.projects?.name || '—'}</div>
                    </Link>
                  </td>
                  <td style={{ color: 'var(--text-2)', fontSize: 13 }}>{inv.projects?.clients?.name || '—'}</td>
                  <td style={{ color: 'var(--text-2)', fontSize: 13 }}>{inv.title}</td>
                  <td>
                    <span className={`pill pill-${invoicePill(inv.status)}`}>{invoiceStatusLabel(inv.status)}</span>
                    {/* FIX (section-12 fix round, real feature gap): see
                        the matching fix in components/invoices/
                        BillingTab.tsx — a client dispute previously had
                        no visible trace anywhere in the agency's own UI
                        once the one-time notification was dismissed. */}
                    {inv.disputed_at && (
                      <span className="pill pill-red pill-sm" style={{ marginLeft: 4 }} title={`Disputed ${formatDate(inv.disputed_at)}`}>
                        Disputed
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{inv.due_date ? formatDate(inv.due_date) : '—'}</td>
                  <td className="td-mono" style={{ textAlign: 'right', fontSize: 12 }}>
                    {formatCurrency(inv.amount, inv.currency)}
                    {inv.amount_paid > 0 && inv.status !== 'paid' && (
                      <div style={{ fontSize: 10.5, color: 'var(--green)' }}>{formatCurrency(inv.amount_paid, inv.currency)} paid</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MetricBlock({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 19, color: color || 'var(--text)' }}>{value}</div>
    </div>
  )
}
