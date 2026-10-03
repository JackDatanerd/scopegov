import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAdminPage } from '@/lib/admin/page-guard'
import { logAdminRead } from '@/lib/auth/admin'
import { fmtUtc } from '@/lib/admin/format'
import { PAID_PLAN_KEYS } from '@/lib/billing/plans'
import styles from '@/styles/admin.module.css'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50
const COLS = 'id, workspace_id, plan_interval, cancels_at_period_end, current_period_end, payment_method_last4, payment_method_type, grace_period_started_at, paystack_subscription_code, needs_paystack_cancel, workspaces!inner(id, name, agency_name, plan_tier, deleted_at)'
const VIEWS = ['all', 'failing', 'cancelling', 'cancel_pending', 'no_subscription', 'suspended'] as const
type View = (typeof VIEWS)[number]
const VIEW_LABEL: Record<View, string> = {
  all: 'All active', failing: 'Payment failing', cancelling: 'Cancelling', cancel_pending: 'Paystack cancel pending',
  no_subscription: 'Paid, no subscription', suspended: 'Suspended / deleted workspaces',
}

// Applies one view's filter. Every view except 'suspended' is scoped to ACTIVE workspaces — the old page counted
// suspended and deleted workspaces as "Healthy"/"OK" because it never looked at workspaces.deleted_at.
function applyView(q: any, view: View) {
  if (view === 'suspended') return q.not('workspaces.deleted_at', 'is', null)
  q = q.is('workspaces.deleted_at', null)
  switch (view) {
    case 'failing': return q.not('grace_period_started_at', 'is', null)
    case 'cancelling': return q.eq('cancels_at_period_end', true)
    case 'cancel_pending': return q.eq('needs_paystack_cancel', true)
    case 'no_subscription': return q.is('paystack_subscription_code', null).in('workspaces.plan_tier', [...PAID_PLAN_KEYS])
    default: return q
  }
}

type SP = { view?: string; page?: string }

export default async function AdminBillingPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireAdminPage() // B1 — a layout redirect does not protect this page's data
  const service = createServiceClient() as any

  const view: View = (VIEWS as readonly string[]).includes(searchParams?.view || '') ? (searchParams.view as View) : 'failing'
  const page = Math.max(1, parseInt(searchParams?.page || '1', 10) || 1)
  const from = (page - 1) * PAGE_SIZE

  await logAdminRead(service, { actor, eventType: 'billing.viewed', targetType: 'billing', targetLabel: 'billing' })

  const countQ = (v: View) => applyView(service.from('billing').select('id, workspaces!inner(id)', { count: 'exact', head: true }), v)
  const [rowsRes, ...countRes] = await Promise.all([
    applyView(service.from('billing').select(COLS, { count: 'exact' }), view)
      .order('grace_period_started_at', { ascending: false, nullsFirst: false }).order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1),
    ...VIEWS.map(v => countQ(v)),
  ])
  const counts = Object.fromEntries(VIEWS.map((v, i) => [v, (countRes[i] as any).error ? null : (countRes[i] as any).count ?? 0])) as Record<View, number | null>

  const total = rowsRes.count ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const href = (over: { view?: View; page?: number }) => {
    const p = new URLSearchParams({ view: over.view ?? view })
    if ((over.page ?? 1) > 1) p.set('page', String(over.page))
    return `/admin/billing?${p}`
  }
  if (!rowsRes.error && page > totalPages) redirect(href({ page: totalPages }))

  const rows: any[] = rowsRes.data || []

  const status = (r: any) => {
    const ws = Array.isArray(r.workspaces) ? r.workspaces[0] : r.workspaces
    if (ws?.deleted_at) {
      return r.needs_paystack_cancel
        ? <span className={`${styles.badge} ${styles.badgeRed}`}>Workspace gone — Paystack cancel pending</span>
        : <span className={`${styles.badge} ${styles.badgeGray}`}>Workspace suspended/deleted</span>
    }
    if (r.grace_period_started_at) return <span className={`${styles.badge} ${styles.badgeRed}`}>Payment failing since {fmtUtc(r.grace_period_started_at).slice(0, 10)}</span>
    if (r.needs_paystack_cancel) return <span className={`${styles.badge} ${styles.badgeRed}`}>Paystack cancel pending</span>
    if (r.cancels_at_period_end) return <span className={`${styles.badge} ${styles.badgeGold}`}>Cancelling</span>
    if (!r.paystack_subscription_code && (PAID_PLAN_KEYS as readonly string[]).includes(ws?.plan_tier)) return <span className={`${styles.badge} ${styles.badgeBlue}`}>No subscription (comped?)</span>
    return <span className={`${styles.badge} ${styles.badgeGreen}`}>OK</span>
  }

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Billing</div>
          <div className={styles.subtitle}>Subscription state per workspace — read-only. For money collected and MRR see <Link href="/admin/finance">Finance</Link>; reconcile actual charges in the Paystack dashboard.</div>
        </div>
      </div>

      {rowsRes.error && (
        <div className={`${styles.notice} ${styles.noticeBad}`}>
          Could not load billing rows ({rowsRes.error.message}). This is a read failure, not an empty list.
        </div>
      )}

      <div className={styles.grid}>
        <div className={`${styles.statCard} ${(counts.failing ?? 0) > 0 ? styles.statBad : styles.statGood}`}>
          <div className={styles.statLabel}>Payment failing</div>
          <div className={styles.statValue}>{counts.failing ?? '?'}</div>
        </div>
        <div className={`${styles.statCard} ${(counts.cancelling ?? 0) > 0 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>Cancelling at period end</div>
          <div className={styles.statValue}>{counts.cancelling ?? '?'}</div>
        </div>
        <div className={`${styles.statCard} ${(counts.cancel_pending ?? 0) > 0 ? styles.statBad : styles.statGood}`}>
          <div className={styles.statLabel}>Paystack cancel pending</div>
          <div className={styles.statValue}>{counts.cancel_pending ?? '?'}</div>
          <div className={styles.statHint}>a suspension could not cancel the subscription — retried daily</div>
        </div>
        <div className={`${styles.statCard} ${(counts.no_subscription ?? 0) > 0 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>Paid plan, no subscription</div>
          <div className={styles.statValue}>{counts.no_subscription ?? '?'}</div>
          <div className={styles.statHint}>comped or broken</div>
        </div>
      </div>

      <div className={styles.tabs}>
        {VIEWS.map(v => (
          <Link key={v} href={href({ view: v })} className={`${styles.tab} ${v === view ? styles.tabActive : ''}`}>
            {VIEW_LABEL[v]}{counts[v] != null ? ` (${counts[v]})` : ''}
          </Link>
        ))}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>{VIEW_LABEL[view]}</div>
        {rowsRes.error ? null : rows.length === 0 ? <div className={styles.empty}>Nothing here.</div> : (
          <table className={styles.table}>
            <thead><tr><th>Workspace</th><th>Plan</th><th>Interval</th><th>Payment method</th><th>Period ends</th><th>Status</th><th>Paystack sub.</th></tr></thead>
            <tbody>
              {rows.map((r: any) => {
                const ws = Array.isArray(r.workspaces) ? r.workspaces[0] : r.workspaces
                return (
                  <tr key={r.id}>
                    <td>{ws?.id ? <Link href={`/admin/workspaces/${ws.id}`}>{ws.agency_name || ws.name || '—'}</Link> : '—'}</td>
                    <td style={{ textTransform: 'capitalize' }}>{ws?.plan_tier}</td>
                    <td>{r.plan_interval || <span className={styles.muted}>—</span>}</td>
                    <td>{r.payment_method_type ? `${r.payment_method_type} •••• ${r.payment_method_last4 || ''}` : <span className={styles.muted}>None</span>}</td>
                    <td className={styles.mono}>{r.current_period_end ? fmtUtc(r.current_period_end).slice(0, 10) : '—'}</td>
                    <td>{status(r)}</td>
                    <td>{r.paystack_subscription_code ? <span className={styles.mono}>{r.paystack_subscription_code.slice(0, 14)}…</span> : <span className={styles.muted}>None</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <div className={styles.pager}>
          {page <= 1
            ? <span className={`btn btn-ghost btn-sm ${styles.pagerDisabled}`}>Previous</span>
            : <Link className="btn btn-ghost btn-sm" href={href({ page: page - 1 })}>Previous</Link>}
          <span>Page {Math.min(page, totalPages)} of {totalPages} · {total} total</span>
          {page >= totalPages
            ? <span className={`btn btn-ghost btn-sm ${styles.pagerDisabled}`}>Next</span>
            : <Link className="btn btn-ghost btn-sm" href={href({ page: page + 1 })}>Next</Link>}
        </div>
      </div>
    </div>
  )
}
