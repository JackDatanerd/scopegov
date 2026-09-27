import { createServiceClient } from '@/lib/supabase/server'
import styles from '@/styles/admin.module.css'

export const dynamic = 'force-dynamic'

export default async function AdminBillingPage() {
  const service = createServiceClient() as any

  const { data: rows } = await service
    .from('billing')
    .select('id, workspace_id, cancels_at_period_end, current_period_end, payment_method_last4, payment_method_type, grace_period_started_at, paystack_subscription_code, workspaces:workspace_id (id, name, agency_name, plan_tier, deleted_at)')
    .order('grace_period_started_at', { ascending: false, nullsFirst: false })

  const inGrace = (rows || []).filter((r: any) => r.grace_period_started_at)
  const cancelling = (rows || []).filter((r: any) => r.cancels_at_period_end && !r.grace_period_started_at)
  const rest = (rows || []).filter((r: any) => !r.grace_period_started_at && !r.cancels_at_period_end)

  const renderRow = (r: any) => (
    <tr key={r.id}>
      <td>{r.workspaces?.agency_name || r.workspaces?.name || '—'}</td>
      <td style={{ textTransform: 'capitalize' }}>{r.workspaces?.plan_tier}</td>
      <td>{r.payment_method_type ? `${r.payment_method_type} •••• ${r.payment_method_last4 || ''}` : <span className={styles.muted}>None</span>}</td>
      <td className={styles.mono}>{r.current_period_end ? new Date(r.current_period_end).toLocaleDateString() : '—'}</td>
      <td>{r.cancels_at_period_end ? <span className={`${styles.badge} ${styles.badgeGold}`}>Cancelling</span> : '—'}</td>
      <td>
        {r.grace_period_started_at
          ? <span className={`${styles.badge} ${styles.badgeRed}`}>Payment failing since {new Date(r.grace_period_started_at).toLocaleDateString()}</span>
          : <span className={`${styles.badge} ${styles.badgeGreen}`}>OK</span>}
      </td>
      <td>{r.paystack_subscription_code ? <span className={styles.mono}>{r.paystack_subscription_code.slice(0, 14)}…</span> : <span className={styles.muted}>None</span>}</td>
    </tr>
  )

  const headerRow = (
    <tr><th>Workspace</th><th>Plan</th><th>Payment method</th><th>Period ends</th><th>Cancellation</th><th>Status</th><th>Paystack sub.</th></tr>
  )

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Billing</div>
          <div className={styles.subtitle}>Read-only — reconcile actual charges in the Paystack dashboard</div>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={`${styles.statCard} ${inGrace.length > 0 ? styles.statBad : styles.statGood}`}>
          <div className={styles.statLabel}>Payment failing</div>
          <div className={styles.statValue}>{inGrace.length}</div>
        </div>
        <div className={`${styles.statCard} ${cancelling.length > 0 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>Cancelling at period end</div>
          <div className={styles.statValue}>{cancelling.length}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Healthy</div>
          <div className={styles.statValue}>{rest.length}</div>
        </div>
      </div>

      {inGrace.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHead}>Payment failing (grace period)</div>
          <table className={styles.table}><thead>{headerRow}</thead><tbody>{inGrace.map(renderRow)}</tbody></table>
        </div>
      )}

      {cancelling.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHead}>Cancelling at period end</div>
          <table className={styles.table}><thead>{headerRow}</thead><tbody>{cancelling.map(renderRow)}</tbody></table>
        </div>
      )}

      <div className={styles.card}>
        <div className={styles.cardHead}>All other subscriptions ({rest.length})</div>
        {rest.length === 0 ? <div className={styles.empty}>Nothing here.</div> : (
          <table className={styles.table}><thead>{headerRow}</thead><tbody>{rest.map(renderRow)}</tbody></table>
        )}
      </div>
    </div>
  )
}
