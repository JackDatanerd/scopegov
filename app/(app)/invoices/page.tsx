// app/(app)/invoices/page.tsx
// Phase 4a: workspace-wide invoice registry, mirrors /sow's pattern.
// Phase 4: portfolio reconciliation strip for VIEW_ALL_PROJECTS users.

import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatDate, formatCurrency, formatCurrencyExact, invoiceStatusLabel, invoicePill } from '@/lib/utils/format'
import { fetchAll } from '@/lib/utils/fetch-all'
import {
  REGISTRY_STATUS_FILTERS, AGING_BUCKETS, agingBucket,
  parseRegistryFilters, projectIdsMatching, applyRegistryFilters,
} from '@/lib/utils/invoice-registry'

export const metadata = { title: 'Invoices' }

const PAGE_SIZE = 50

export default async function InvoicesPage({ searchParams }: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>
}) {
  const sp = await searchParams
  const filters = parseRegistryFilters(sp)
  const page = Math.max(1, Math.min(1000, parseInt(sp.page || '1', 10) || 1))
  const session = await getSession()
  if (!session) redirect('/login')
  if (!hasPermission(session, 'VIEW_FINANCIALS')) redirect('/dashboard')

  const service = createServiceClient()
  const isSoloCapped = session.planTier === 'solo'
  // Solo plans see only their 10 most recent invoices; everyone else pages through all of them.
  const pageSize = isSoloCapped ? 10 : PAGE_SIZE

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

  // FEATURE (section-12 audit, pass 2): filter, search and page — the list used to be
  // one unfiltered, hard-capped (500) table. Invoices of a soft-deleted project are
  // excluded (they link to a project page that 404s).
  const textProjectIds = await projectIdsMatching(service, session.workspaceId, filters.q)
  const from = isSoloCapped ? 0 : (page - 1) * pageSize
  let invoicesQuery = (service as any)
    .from('invoices')
    .select(`id, invoice_number, title, amount, amount_paid, currency, status, due_date, sent_at, paid_at, created_at, disputed_at, dispute_resolved_at,
      projects!inner(id, name, deleted_at, clients(name))`, { count: 'exact' })
    .eq('workspace_id', session.workspaceId)
    .is('projects.deleted_at', null)
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1)
  if (allowedProjectIds !== null) invoicesQuery = invoicesQuery.in('project_id', allowedProjectIds)
  invoicesQuery = applyRegistryFilters(invoicesQuery, filters, textProjectIds)

  const { data: invoices = [], error: invErr, count: filteredCount } = await invoicesQuery

  if (invErr) console.error('Invoices registry error:', invErr)
  const safeInvoices = invoices || []
  const hasNextPage = !isSoloCapped && (filteredCount ?? 0) > from + pageSize
  const exportQuery = new URLSearchParams()
  if (filters.status) exportQuery.set('status', filters.status)
  if (filters.q) exportQuery.set('q', filters.q)

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
    let q = (service as any).from('invoices').select('id, projects!inner(deleted_at)', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).is('projects.deleted_at', null)
    if (allowedProjectIds !== null) q = q.in('project_id', allowedProjectIds)
    if (statuses) q = q.in('status', statuses)
    return q
  }
  const [{ count: totalCount }, { count: outstandingCount }, { count: overdueCount }] = await Promise.all([
    countQuery(),
    countQuery(['sent', 'partially_paid', 'overdue']),
    countQuery(['overdue']),
  ])

  // FIX (section-12 audit, pass 2): "Collected" came from an unpaginated select, and
  // PostgREST silently truncates every response at max_rows (1000 on Supabase) — a
  // workspace past 1,000 invoices under-reported it with no sign anything was cut.
  // fetchAll pages through every row. The same rows feed the new receivables view
  // (outstanding balance + aging per currency), which used to exist only as a count.
  //
  // Grouped by currency, never blended: this app supports per-project currency, so
  // adding unlike units together would be wrong, not a rounding error.
  const ledgerRows = await fetchAll<any>('invoice registry ledger', (fromRow, toRow) => {
    let q = (service as any)
      .from('invoices').select('id, currency, amount, amount_paid, status, due_date, projects!inner(deleted_at)')
      .eq('workspace_id', workspaceId).is('projects.deleted_at', null)
      .not('status', 'in', '(draft,void)')
      .order('id').range(fromRow, toRow)
    if (allowedProjectIds !== null) q = q.in('project_id', allowedProjectIds)
    return q
  }).catch((e: unknown) => { console.error('Invoices registry ledger error:', e); return [] as any[] })

  const paidByCurrency = new Map<string, number>()
  const receivables = new Map<string, { outstanding: number; buckets: number[] }>()
  const nowDate = new Date()
  for (const i of ledgerRows) {
    const cur = i.currency || wsCurrency
    paidByCurrency.set(cur, (paidByCurrency.get(cur) || 0) + Number(i.amount_paid || 0))
    if (['sent', 'partially_paid', 'overdue'].includes(i.status)) {
      const balance = Math.round((Number(i.amount) - Number(i.amount_paid || 0)) * 100) / 100
      if (balance > 0) {
        const acc = receivables.get(cur) || { outstanding: 0, buckets: [0, 0, 0, 0, 0] }
        acc.outstanding += balance
        acc.buckets[agingBucket(i.due_date, nowDate)] += balance
        receivables.set(cur, acc)
      }
    }
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
        {!isSoloCapped && (
          <a href={`/api/invoices/export${exportQuery.toString() ? `?${exportQuery.toString()}` : ''}`}>
            <button className="btn btn-ghost btn-sm"><i className="ti ti-download" style={{ fontSize: 12 }} /> Export CSV</button>
          </a>
        )}
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
          {/* The COUNT hid what matters: how much money is still owed (per currency). */}
          <div className="mc-sub">
            {receivables.size === 0 ? 'Awaiting payment' : Array.from(receivables.entries()).map(([cur, r]) => formatCurrencyExact(r.outstanding, cur)).join(' · ') + ' owed'}
          </div>
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
            <div className="mc-val green">{formatCurrencyExact(0, wsCurrency)}</div>
          ) : (
            Array.from(paidByCurrency.entries()).map(([cur, amount], i) => (
              <div key={cur} className="mc-val green" style={i > 0 ? { fontSize: '0.7em', marginTop: 2 } : undefined}>
                {formatCurrencyExact(amount, cur)}
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

      {receivables.size > 0 && (
        <div className="surface surface-p" style={{ marginBottom: 22 }}>
          <div className="sec-title" style={{ marginBottom: 10 }}>Receivables aging</div>
          {Array.from(receivables.entries()).map(([cur, r], i, arr) => (
            <div key={cur} style={{ marginBottom: i < arr.length - 1 ? 16 : 0 }}>
              {arr.length > 1 && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 }}>{cur}</div>}
              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                {AGING_BUCKETS.map((label, bi) => (
                  <div key={label}>
                    <MetricBlock label={label} value={formatCurrencyExact(r.buckets[bi], cur)}
                      color={bi === 0 ? undefined : bi >= 3 ? 'var(--red)' : 'var(--gold)'} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <form method="get" action="/invoices" style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {filters.status && <input type="hidden" name="status" value={filters.status} />}
        <input className="finp" name="q" defaultValue={filters.q} placeholder="Search number, title, project or client…" style={{ maxWidth: 320 }} />
        <button className="btn btn-ghost btn-sm" type="submit">Search</button>
        {filters.q && (
          <Link href={filters.status ? `/invoices?status=${filters.status}` : '/invoices'}>
            <button className="btn btn-ghost btn-sm" type="button">Clear</button>
          </Link>
        )}
      </form>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {REGISTRY_STATUS_FILTERS.map(f => {
          const qs = new URLSearchParams()
          if (f.id) qs.set('status', f.id)
          if (filters.q) qs.set('q', filters.q)
          return (
            <Link key={f.id || 'all'} href={qs.toString() ? `/invoices?${qs.toString()}` : '/invoices'}>
              <button className={`btn btn-sm ${filters.status === f.id ? 'btn-primary' : 'btn-ghost'}`} type="button">{f.label}</button>
            </Link>
          )
        })}
      </div>

      {!safeInvoices.length ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-receipt-2 empty-state-icon" />
            <p className="empty-state-title">{filters.status || filters.q ? 'No invoices match' : 'No invoices yet'}</p>
            <p className="empty-state-sub">
              {filters.status || filters.q
                ? 'Try a different filter or search.'
                : 'Create an invoice from a project\u2019s Billing tab, against a milestone, signed SOW, or accepted change order.'}
            </p>
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
                <th></th>
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
                    {inv.disputed_at && !inv.dispute_resolved_at && (
                      <span className="pill pill-red pill-sm" style={{ marginLeft: 4 }} title={`Disputed ${formatDate(inv.disputed_at)}`}>
                        Disputed
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{inv.due_date ? formatDate(inv.due_date) : '—'}</td>
                  <td className="td-mono" style={{ textAlign: 'right', fontSize: 12 }}>
                    {formatCurrencyExact(inv.amount, inv.currency)}
                    {inv.amount_paid > 0 && inv.status !== 'paid' && inv.status !== 'void' && (
                      <div style={{ fontSize: 10.5, color: 'var(--green)' }}>{formatCurrencyExact(inv.amount_paid, inv.currency)} paid · {formatCurrencyExact(Math.max(0, Number(inv.amount) - Number(inv.amount_paid)), inv.currency)} due</div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {inv.status !== 'draft' && inv.status !== 'void' && (
                      <a href={`/api/pdf/invoice/${inv.id}`} target="_blank" rel="noreferrer" title="Download PDF" style={{ color: 'var(--text-3)' }}>
                        <i className="ti ti-file-type-pdf" style={{ fontSize: 15 }} />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isSoloCapped && (page > 1 || hasNextPage) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, fontSize: 12.5, color: 'var(--text-3)' }}>
          <span>Page {page}{filteredCount != null ? ` · ${filteredCount} invoice${filteredCount === 1 ? '' : 's'}` : ''}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {page > 1 && (
              <Link href={`/invoices?${new URLSearchParams({ ...(filters.status ? { status: filters.status } : {}), ...(filters.q ? { q: filters.q } : {}), page: String(page - 1) }).toString()}`}>
                <button className="btn btn-ghost btn-sm" type="button">Previous</button>
              </Link>
            )}
            {hasNextPage && (
              <Link href={`/invoices?${new URLSearchParams({ ...(filters.status ? { status: filters.status } : {}), ...(filters.q ? { q: filters.q } : {}), page: String(page + 1) }).toString()}`}>
                <button className="btn btn-ghost btn-sm" type="button">Next</button>
              </Link>
            )}
          </div>
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
