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
    const { data: ids } = await (service as any)
      .from('project_members')
      .select('project_id, workspace_members!inner(user_id)')
      .eq('workspace_members.user_id', session.id)
    allowedProjectIds = (ids || []).map((r: any) => r.project_id)
  }

  let invoicesQuery = (service as any)
    .from('invoices')
    .select(`id, invoice_number, title, amount, amount_paid, currency, status, due_date, sent_at, paid_at, created_at,
      projects(id, name, clients(name))`)
    .eq('workspace_id', session.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (allowedProjectIds !== null) invoicesQuery = invoicesQuery.in('project_id', allowedProjectIds)

  const { data: invoices = [], error: invErr } = await invoicesQuery

  if (invErr) console.error('Invoices registry error:', invErr)
  const safeInvoices = invoices || []

  const stats = {
    total:      safeInvoices.length,
    outstanding: safeInvoices.filter((i: any) => ['sent', 'partially_paid', 'overdue'].includes(i.status)).length,
    overdue:    safeInvoices.filter((i: any) => i.status === 'overdue').length,
    paidValue:  safeInvoices.filter((i: any) => i.status !== 'draft' && i.status !== 'void').reduce((s: number, i: any) => s + Number(i.amount_paid || 0), 0),
  }

  // Phase 4: portfolio reconciliation, only for members who can see the whole workspace.
  let portfolio: { contractedValue: number; invoicedToDate: number; paidToDate: number; atRiskValue: number } | null = null
  if (hasPermission(session, 'VIEW_ALL_PROJECTS')) {
    const { data: rows } = await (service as any)
      .from('contract_reconciliation_snapshots')
      .select('project_id, contracted_value, invoiced_to_date, paid_to_date, at_risk_value, snapshot_date')
      .eq('workspace_id', session.workspaceId)
      .order('snapshot_date', { ascending: true })
    const latestByProject = new Map<string, any>()
    for (const r of (rows || [])) latestByProject.set(r.project_id, r)
    if (latestByProject.size > 0) {
      portfolio = Array.from(latestByProject.values()).reduce((acc, r) => ({
        contractedValue: acc.contractedValue + (r.contracted_value || 0),
        invoicedToDate:  acc.invoicedToDate + (r.invoiced_to_date || 0),
        paidToDate:      acc.paidToDate + (r.paid_to_date || 0),
        atRiskValue:     acc.atRiskValue + (r.at_risk_value || 0),
      }), { contractedValue: 0, invoicedToDate: 0, paidToDate: 0, atRiskValue: 0 })
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
          <div className="mc-val green">{formatCurrency(stats.paidValue, wsCurrency, true)}</div>
          <div className="mc-sub">All-time</div>
        </div>
      </div>

      {portfolio && portfolio.contractedValue > 0 && (
        <div className="surface surface-p" style={{ marginBottom: 22 }}>
          <div className="sec-title" style={{ marginBottom: 10 }}>Portfolio reconciliation</div>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <MetricBlock label="Contracted" value={formatCurrency(portfolio.contractedValue, wsCurrency)} />
            <MetricBlock label="Invoiced" value={formatCurrency(portfolio.invoicedToDate, wsCurrency)} color="var(--blue)" />
            <MetricBlock label="Paid" value={formatCurrency(portfolio.paidToDate, wsCurrency)} color="var(--green)" />
            {portfolio.atRiskValue > 0 && <MetricBlock label="At risk" value={formatCurrency(portfolio.atRiskValue, wsCurrency)} color="var(--gold)" />}
          </div>
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
