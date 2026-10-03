import { createServiceClient } from '@/lib/supabase/server'
import { requireAdminPage } from '@/lib/admin/page-guard'
import { heartbeatExpectations, CRON_BY_NAME } from '@/lib/cron/manifest'
import styles from '@/styles/admin.module.css'

export const dynamic = 'force-dynamic'

function fmtAgo(iso: string | undefined): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.round(ms / 60_000)}m ago`
  if (hours < 48) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export default async function AdminSystemPage() {
  await requireAdminPage() // B1 — a layout redirect does not protect this page's data
  const service = createServiceClient() as any

  const [heartbeatsRes, checkoutsRes, webhooksRes] = await Promise.all([
    service.from('cron_heartbeats').select('cron_name, last_ok_at, last_result'),
    // billing_checkouts rows are consumed by webhooks/paystack once the
    // matching subscription.create event lands — a growing unconsumed
    // count means checkouts are starting but the webhook isn't landing.
    service.from('billing_checkouts').select('id', { count: 'exact', head: true }).is('consumed_at', null),
    service.from('processed_webhook_events').select('idempotency_key', { count: 'exact', head: true }).gte('processed_at', new Date(Date.now() - 86400_000).toISOString()),
  ])

  // B6: when the heartbeat read failed every cron used to render as "never ran / Stale" — a false alarm on the very
  // page meant to be trusted during an incident. A failed read is now shown as unknown.
  const { data: heartbeats } = heartbeatsRes
  const { count: unconsumedCheckouts } = checkoutsRes
  const { count: webhooksLast24h } = webhooksRes
  const failed = ([['cron heartbeats', heartbeatsRes], ['unconsumed checkouts', checkoutsRes], ['processed webhooks', webhooksRes]] as const)
    .filter(([, r]) => (r as any).error).map(([l]) => l)
  if (failed.length) console.error('[admin] system reads failed:', failed.join(', '))
  const heartbeatsUnknown = !!heartbeatsRes.error

  const seen = new Map<string, { last_ok_at: string; last_result: unknown }>(
    (heartbeats || []).map((h: any) => [h.cron_name, h])
  )
  const expectations = heartbeatExpectations()
  const now = Date.now()

  const rows = Object.entries(expectations).map(([name, toleranceHours]) => {
    const hb = seen.get(name)
    const ageHours = hb ? (now - new Date(hb.last_ok_at).getTime()) / 3_600_000 : Infinity
    const stale = !heartbeatsUnknown && ageHours > toleranceHours
    return { name, toleranceHours, lastOkAt: hb?.last_ok_at, stale, cadence: CRON_BY_NAME.get(name)?.cadence || '—' }
  }).sort((a, b) => (b.stale ? 1 : 0) - (a.stale ? 1 : 0))

  const staleCount = rows.filter(r => r.stale).length

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>System health</div>
          <div className={styles.subtitle}>Cron heartbeats and unconsumed background work</div>
        </div>
      </div>

      {failed.length > 0 && (
        <div className={`${styles.notice} ${styles.noticeBad}`}>
          Could not load: {failed.join(', ')}. Those figures are unknown, not zero or stale — reload to retry.
        </div>
      )}

      <div className={styles.grid}>
        <div className={`${styles.statCard} ${staleCount > 0 ? styles.statBad : styles.statGood}`}>
          <div className={styles.statLabel}>Stale crons</div>
          <div className={styles.statValue}>{heartbeatsUnknown ? '?' : staleCount} / {rows.length}</div>
        </div>
        <div className={`${styles.statCard} ${(unconsumedCheckouts ?? 0) > 5 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>Unconsumed checkouts</div>
          <div className={styles.statValue}>{checkoutsRes.error ? '?' : (unconsumedCheckouts ?? 0)}</div>
          <div className={styles.statHint}>started, no matching webhook yet</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Webhooks processed (24h)</div>
          <div className={styles.statValue}>{webhooksRes.error ? '?' : (webhooksLast24h ?? 0)}</div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Cron jobs</div>
        <table className={styles.table}>
          <thead><tr><th>Job</th><th>Cadence</th><th>Last success</th><th>Tolerance</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.name}>
                <td className={styles.mono}>{r.name}</td>
                <td>{r.cadence}</td>
                <td className={styles.mono}>{fmtAgo(r.lastOkAt)}</td>
                <td className={styles.mono}>{r.toleranceHours}h</td>
                <td>
                  {heartbeatsUnknown
                    ? <span className={`${styles.badge} ${styles.badgeGray}`}>Unknown</span>
                    : r.stale
                      ? <span className={`${styles.badge} ${styles.badgeRed}`}>Stale</span>
                      : <span className={`${styles.badge} ${styles.badgeGreen}`}>Healthy</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
