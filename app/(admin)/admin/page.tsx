import { createServiceClient } from '@/lib/supabase/server'
import { requireAdminPage } from '@/lib/admin/page-guard'
import { heartbeatExpectations } from '@/lib/cron/manifest'
import styles from '@/styles/admin.module.css'

export const dynamic = 'force-dynamic'

const STALE_SOW_DAYS = 7
const STALE_CO_DAYS = 5

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString()
}

export default async function AdminOverviewPage() {
  // B1: a layout redirect does not protect this page's data — guard here, before any service-role read.
  await requireAdminPage()
  const service = createServiceClient() as any
  const weekAgo = daysAgoIso(7)

  const [
    totalWorkspacesRes,
    deletedWorkspacesRes,
    byPlanRes,
    newWorkspacesRes,
    totalUsersRes,
    staleSowsRes,
    staleCosRes,
    pastDueTrialsRes,
    heartbeatsRes,
  ] = await Promise.all([
    service.from('workspaces').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    service.from('workspaces').select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null),
    // GROUP BY in SQL: selecting every row and counting here was silently truncated at PostgREST's 1000-row cap (B8).
    service.rpc('admin_workspace_plan_counts'),
    service.from('workspaces').select('id', { count: 'exact', head: true }).is('deleted_at', null).gte('created_at', weekAgo),
    service.from('users').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    service.from('sow_documents').select('id', { count: 'exact', head: true }).eq('status', 'awaiting_signature').lt('updated_at', daysAgoIso(STALE_SOW_DAYS)),
    service.from('change_orders').select('id', { count: 'exact', head: true }).eq('status', 'awaiting_response').lt('updated_at', daysAgoIso(STALE_CO_DAYS)),
    service.from('workspaces').select('id', { count: 'exact', head: true }).is('deleted_at', null).eq('plan_tier', 'trial').lt('trial_ends_at', new Date().toISOString()),
    service.from('cron_heartbeats').select('cron_name, last_ok_at, last_result').order('cron_name'),
  ])

  // B5/B6: `?? 0` on a failed query rendered a believable zero. Any failed read is listed instead.
  const failed = ([
    ['active workspaces', totalWorkspacesRes], ['deleted workspaces', deletedWorkspacesRes], ['plan breakdown', byPlanRes],
    ['new workspaces', newWorkspacesRes], ['users', totalUsersRes], ['stuck SOWs', staleSowsRes],
    ['stuck change orders', staleCosRes], ['past-due trials', pastDueTrialsRes], ['cron heartbeats', heartbeatsRes],
  ] as const).filter(([, r]) => (r as any).error).map(([label]) => label)
  if (failed.length) console.error('[admin] overview reads failed:', failed.join(', '))
  const { count: totalWorkspaces } = totalWorkspacesRes
  const { count: deletedWorkspaces } = deletedWorkspacesRes
  const { count: newWorkspacesThisWeek } = newWorkspacesRes
  const { count: totalUsers } = totalUsersRes
  const { count: staleSows } = staleSowsRes
  const { count: staleCos } = staleCosRes
  const { count: pastDueTrials } = pastDueTrialsRes
  const heartbeats = heartbeatsRes.data

  const planCounts: Record<string, number> = {}
  for (const r of (byPlanRes.data || []) as Array<{ plan_tier: string; n: number | string }>) planCounts[r.plan_tier] = Number(r.n) || 0

  // Same per-cron tolerance the watchdog itself pages on (lib/cron/manifest.ts)
  // rather than one blanket 24h — a 15-minute cron and a weekly one don't
  // share a staleness bar.
  const expectations = heartbeatExpectations()
  const now = Date.now()
  const seen = new Map<string, string>((heartbeats || []).map((h: any) => [h.cron_name, h.last_ok_at]))
  const staleCronCount = Object.entries(expectations).filter(([name, toleranceHours]) => {
    const lastOkAt = seen.get(name)
    const ageHours = lastOkAt ? (now - new Date(lastOkAt).getTime()) / 3_600_000 : Infinity
    return ageHours > toleranceHours
  }).length

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Overview</div>
          <div className={styles.subtitle}>Cross-workspace snapshot, refreshed on load</div>
        </div>
      </div>

      {failed.length > 0 && (
        <div className={`${styles.notice} ${styles.noticeBad}`}>
          Could not load: {failed.join(', ')}. The figures below for those are missing, not zero — reload to retry.
        </div>
      )}

      <div className={styles.grid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Active workspaces</div>
          <div className={styles.statValue}>{totalWorkspaces ?? 0}</div>
          <div className={styles.statHint}>{deletedWorkspaces ?? 0} deleted</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>New this week</div>
          <div className={styles.statValue}>{newWorkspacesThisWeek ?? 0}</div>
          <div className={styles.statHint}>workspaces created</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Total users</div>
          <div className={styles.statValue}>{totalUsers ?? 0}</div>
        </div>
        <div className={`${styles.statCard} ${(pastDueTrials ?? 0) > 0 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>Trials past due</div>
          <div className={styles.statValue}>{pastDueTrials ?? 0}</div>
          <div className={styles.statHint}>trial_ends_at in the past</div>
        </div>
        <div className={`${styles.statCard} ${(staleSows ?? 0) > 0 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>Stuck SOWs</div>
          <div className={styles.statValue}>{staleSows ?? 0}</div>
          <div className={styles.statHint}>awaiting signature &gt;{STALE_SOW_DAYS}d</div>
        </div>
        <div className={`${styles.statCard} ${(staleCos ?? 0) > 0 ? styles.statWarn : ''}`}>
          <div className={styles.statLabel}>Stuck change orders</div>
          <div className={styles.statValue}>{staleCos ?? 0}</div>
          <div className={styles.statHint}>awaiting response &gt;{STALE_CO_DAYS}d</div>
        </div>
        <div className={`${styles.statCard} ${heartbeatsRes.error || staleCronCount > 0 ? styles.statBad : styles.statGood}`}>
          <div className={styles.statLabel}>Cron jobs stale</div>
          <div className={styles.statValue}>{heartbeatsRes.error ? '?' : staleCronCount}</div>
          <div className={styles.statHint}>past their own tolerance, of {Object.keys(expectations).length} crons</div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Workspaces by plan</div>
        <table className={styles.table}>
          <thead><tr><th>Plan</th><th>Workspaces</th></tr></thead>
          <tbody>
            {(['trial', 'solo', 'starter', 'pro', 'agency'] as const).map(plan => (
              <tr key={plan}>
                <td style={{ textTransform: 'capitalize' }}>{plan}</td>
                <td className={styles.mono}>{planCounts[plan] || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
