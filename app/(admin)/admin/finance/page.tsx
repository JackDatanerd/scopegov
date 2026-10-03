import Link from 'next/link'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAdminPage } from '@/lib/admin/page-guard'
import { logAdminRead } from '@/lib/auth/admin'
import { fetchAll } from '@/lib/utils/fetch-all'
import { fmtUtc } from '@/lib/admin/format'
import { shapeFinance, estimateMrr, fmtMonth, fmtMoney, currentMonthKey, type BillingMrrRow } from '@/lib/admin/finance'
import { PAID_PLAN_KEYS } from '@/lib/billing/plans'
import styles from '@/styles/admin.module.css'

export const dynamic = 'force-dynamic'

const MONTHS_SHOWN = 12
const RECENT_LIMIT = 40
const FEED_TYPES = [
  'billing.payment_succeeded', 'billing.refund_processed', 'billing.charge_dispute_create', 'billing.charge_dispute_resolve',
  'billing.payment_failed_grace_started', 'billing.payment_retry_failed',
]
const FEED_LABEL: Record<string, { label: string; cls: string }> = {
  'billing.payment_succeeded': { label: 'Payment', cls: 'badgeGreen' },
  'billing.refund_processed': { label: 'Refund', cls: 'badgeGold' },
  'billing.charge_dispute_create': { label: 'Dispute opened', cls: 'badgeRed' },
  'billing.charge_dispute_resolve': { label: 'Dispute resolved', cls: 'badgeBlue' },
  'billing.payment_failed_grace_started': { label: 'Payment failed', cls: 'badgeRed' },
  'billing.payment_retry_failed': { label: 'Retry failed', cls: 'badgeRed' },
}

// FEATURE (Admin panel independent audit — G5): the panel had no view of money at all. Billing showed per-workspace
// subscription STATE; nothing showed what was actually collected, refunded, failing or disputed, or what recurring
// revenue the subscriptions represent. Collected/refunded/failed/disputed come from the audit_log rows the Paystack
// webhook already writes (the same source as each customer's own Payment history); MRR is an ESTIMATE at list price.
export default async function AdminFinancePage() {
  const actor = await requireAdminPage()
  const service = createServiceClient() as any

  await logAdminRead(service, { actor, eventType: 'finance.viewed', targetType: 'billing', targetLabel: 'finance' })

  const subsPromise = fetchAll<any>('admin finance subscriptions', (from, to) =>
    service.from('billing')
      .select('workspace_id, plan_interval, paystack_subscription_code, cancels_at_period_end, grace_period_started_at, workspaces!inner(plan_tier, deleted_at)')
      .is('workspaces.deleted_at', null).order('workspace_id').range(from, to),
  ).then(rows => ({ rows, failed: false }), (e: unknown) => {
    console.error('[admin] finance subscriptions read failed:', e)
    return { rows: [] as any[], failed: true }
  })

  const [summaryRes, planRes, feedRes, subs] = await Promise.all([
    service.rpc('admin_finance_summary', { p_months: MONTHS_SHOWN }),
    service.rpc('admin_workspace_plan_counts'),
    service.from('audit_log')
      .select('id, workspace_id, event_type, created_at, metadata')
      .in('event_type', FEED_TYPES)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(RECENT_LIMIT),
    subsPromise,
  ])

  const finance = shapeFinance(summaryRes.data)
  const currencies = Object.keys(finance).sort()
  const thisMonth = currentMonthKey()

  const mrrRows: BillingMrrRow[] = subs.rows.map((r: any) => {
    const ws = Array.isArray(r.workspaces) ? r.workspaces[0] : r.workspaces
    return { plan_tier: ws?.plan_tier ?? null, plan_interval: r.plan_interval, paystack_subscription_code: r.paystack_subscription_code, cancels_at_period_end: r.cancels_at_period_end, grace_period_started_at: r.grace_period_started_at }
  })
  const mrr = estimateMrr(mrrRows)

  // Paid-plan workspaces that hold NO Paystack subscription are comped (admin change-plan) or broken — either way they
  // are entitlement with no revenue behind it, which is exactly what this page exists to make visible.
  const planCounts: Record<string, number> = {}
  for (const r of (planRes.data || []) as Array<{ plan_tier: string; n: number | string }>) planCounts[r.plan_tier] = Number(r.n) || 0
  const paidWorkspaces = PAID_PLAN_KEYS.reduce((sum, k) => sum + (planCounts[k] || 0), 0)
  const noSubscription = planRes.error || subs.failed ? null : Math.max(0, paidWorkspaces - mrr.subscriptions)

  const feed: any[] = feedRes.data || []
  const wsIds = Array.from(new Set(feed.map(f => f.workspace_id).filter(Boolean)))
  const names = new Map<string, string>()
  if (wsIds.length) {
    const { data: ws, error } = await service.from('workspaces').select('id, name, agency_name').in('id', wsIds)
    if (error) console.error('[admin] finance feed workspace names failed:', error.message)
    for (const w of ws || []) names.set(w.id, w.agency_name || w.name)
  }

  const failed = ([['monthly totals', summaryRes], ['plan counts', planRes], ['recent events', feedRes]] as const)
    .filter(([, r]) => (r as any).error).map(([l]) => l)
  if (subs.failed) failed.push('subscriptions' as any)
  if (failed.length) console.error('[admin] finance reads failed:', failed.join(', '), summaryRes.error?.message ?? '')

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Finance</div>
          <div className={styles.subtitle}>
            Collected / refunded / failed come from Paystack webhook events recorded in each workspace&rsquo;s audit log — reconcile against the Paystack dashboard.
            MRR is an estimate at list price. Months are UTC.
          </div>
        </div>
      </div>

      {failed.length > 0 && (
        <div className={`${styles.notice} ${styles.noticeBad}`}>
          Could not load: {failed.join(', ')}. Those figures are missing, not zero — reload to retry.
          {summaryRes.error && /admin_finance_summary/.test(summaryRes.error.message || '') && ' (Has migration 141 been applied?)'}
        </div>
      )}

      <div className={styles.grid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Estimated MRR</div>
          <div className={styles.statValue}>{subs.failed ? '?' : fmtMoney(mrr.mrrUsd, 'USD')}</div>
          <div className={styles.statHint}>{mrr.subscriptions} paying subscription{mrr.subscriptions === 1 ? '' : 's'}, list price{mrr.assumedMonthly ? ` (${mrr.assumedMonthly} with no interval priced monthly)` : ''}</div>
        </div>
        <div className={`${styles.statCard} ${mrr.atRiskCount > 0 ? styles.statBad : ''}`}>
          <div className={styles.statLabel}>MRR at risk (payment failing)</div>
          <div className={styles.statValue}>{subs.failed ? '?' : fmtMoney(mrr.atRiskUsd, 'USD')}</div>
          <div className={styles.statHint}>{mrr.atRiskCount} in grace period</div>
        </div>
        <div className={`${styles.statCard} ${mrr.cancellingCount > 0 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>MRR churning (cancelling)</div>
          <div className={styles.statValue}>{subs.failed ? '?' : fmtMoney(mrr.cancellingUsd, 'USD')}</div>
          <div className={styles.statHint}>{mrr.cancellingCount} ending at period end</div>
        </div>
        <div className={`${styles.statCard} ${(noSubscription ?? 0) > 0 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>Paid plan, no subscription</div>
          <div className={styles.statValue}>{noSubscription ?? '?'}</div>
          <div className={styles.statHint}>comped or broken — entitlement with no revenue</div>
        </div>
      </div>

      {currencies.length === 0 && !summaryRes.error ? (
        <div className={styles.card}><div className={styles.empty}>No payments, refunds or failures recorded in the last {MONTHS_SHOWN} months.</div></div>
      ) : currencies.map(cur => {
        const months = Object.keys(finance[cur]).sort().reverse()
        const cm = finance[cur][thisMonth]
        return (
          <div key={cur} className={styles.card}>
            <div className={styles.cardHead}>
              <span>{cur === '?' ? 'Unknown currency' : cur} — by month</span>
              {cm && <span className={styles.muted}>This month: {fmtMoney(cm.payment.total, cur)} collected · {fmtMoney(cm.refund.total, cur)} refunded</span>}
            </div>
            <table className={styles.table}>
              <thead><tr><th>Month</th><th>Collected</th><th>Payments</th><th>Refunded</th><th>Net</th><th>Failed charges</th><th>Disputes</th></tr></thead>
              <tbody>
                {months.map(m => {
                  const b = finance[cur][m]
                  return (
                    <tr key={m}>
                      <td>{fmtMonth(m)}</td>
                      <td className={styles.mono}>{fmtMoney(b.payment.total, cur)}</td>
                      <td className={styles.mono}>{b.payment.n}</td>
                      <td className={styles.mono}>{b.refund.n ? fmtMoney(b.refund.total, cur) : '—'}</td>
                      <td className={styles.mono}>{fmtMoney(b.payment.total - b.refund.total, cur)}</td>
                      <td className={styles.mono}>{b.failed.n || '—'}</td>
                      <td className={styles.mono}>{b.dispute.n ? `${b.dispute.n} (${fmtMoney(b.dispute.total, cur)})` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}

      <div className={styles.card}>
        <div className={styles.cardHead}>Recent money events (all workspaces)</div>
        {feedRes.error ? null : feed.length === 0 ? (
          <div className={styles.empty}>Nothing recorded yet.</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>When</th><th>Event</th><th>Workspace</th><th>Amount</th><th>Reference</th></tr></thead>
            <tbody>
              {feed.map(f => {
                const meta = FEED_LABEL[f.event_type] || { label: f.event_type, cls: 'badgeGray' }
                const amount = typeof f.metadata?.amount === 'number' ? fmtMoney(f.metadata.amount, String(f.metadata?.currency || '?').toUpperCase()) : '—'
                return (
                  <tr key={f.id}>
                    <td className={styles.mono}>{fmtUtc(f.created_at)}</td>
                    <td><span className={`${styles.badge} ${(styles as any)[meta.cls]}`}>{meta.label}</span></td>
                    <td>{f.workspace_id
                      ? <Link href={`/admin/workspaces/${f.workspace_id}`}>{names.get(f.workspace_id) || f.workspace_id.slice(0, 8)}</Link>
                      : <span className={styles.muted}>—</span>}</td>
                    <td className={styles.mono}>{amount}</td>
                    <td className={styles.mono}>{f.metadata?.reference ? String(f.metadata.reference).slice(0, 24) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
