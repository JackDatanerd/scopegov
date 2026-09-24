export const runtime = 'nodejs'
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { CronRun } from '@/lib/utils/cron-run'
import { pruneInBatches } from '@/lib/utils/retention'

// Retention for the append-only tables this codebase writes to without ever reading back past a window.
//
// FIX (Notifications & email fix round): nothing ever deleted a notification. Every project event
// fans out to up to 25 recipients, so `notifications` only grew, and its only index was partial
// (read = false), leaving the bell's list query to filter an ever-larger table. Read notifications
// are kept 90 days (long enough to scroll back through a project's history); anything older than
// 180 days is dropped even if it was never opened — an unread notification about an event half a
// year ago is not actionable. email_log (delivery/bounce tracking) is kept 180 days.
//
// FIX (cron/portal audit round 3):
//   • Deletes are batched (lib/utils/retention.ts). A single unbounded DELETE over a table that had never
//     been pruned could exceed the statement timeout and fail identically every night.
//   • Runs on CronRun: a failed step now alerts immediately (it used to return 207 and rely on the
//     watchdog noticing the missing heartbeat ~27h later) and the steps are independent.
//   • ai_usage_log is pruned here. Its migration comment said "lib/utils/rate-limit.ts / a future cron
//     route" would do it; rate-limit.ts never did and no cron ever did, so it grew by one row per AI call
//     forever. The rate-limit windows are minutes-to-hours; 30 days is generous.
//   • cron_run_history (migration 074) is pruned to 60 days.
//   • The two nightly snapshot tables are downsampled to month-start rows once older than 400 days
//     (prune_snapshot_history, migration 074) — daily granularity is only ever charted for the recent
//     window, and they otherwise grow by workspaces x days / projects x days without bound.
//
// SCHEDULING: crons are triggered by the external scopegov-cron-worker (vercel.json no longer lists
// them) — daily, e.g. 02:30 UTC. See lib/cron/manifest.ts, which is the single list of what has to be
// registered there and what the watchdog expects.

const READ_RETENTION_DAYS     = 90
const ANY_RETENTION_DAYS      = 180
const EMAIL_LOG_DAYS          = 180
const AI_USAGE_DAYS           = 30
const CRON_HISTORY_DAYS       = 60
const SNAPSHOT_DAILY_KEEP_DAYS = 400

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient() as any
  try {
    const run = new CronRun(service, 'notification-cleanup')
    const now = Date.now()
    const iso = (days: number) => new Date(now - days * 86400000).toISOString()
    const remaining: string[] = []

    await run.step('prune read notifications', async () => {
      const r = await pruneInBatches(service, 'notifications', q => q.eq('read', true).lt('created_at', iso(READ_RETENTION_DAYS)))
      run.result.readPurged = r.deleted
      if (r.truncated) remaining.push('notifications(read)')
    })
    await run.step('prune old notifications', async () => {
      const r = await pruneInBatches(service, 'notifications', q => q.lt('created_at', iso(ANY_RETENTION_DAYS)))
      run.result.oldPurged = r.deleted
      if (r.truncated) remaining.push('notifications(old)')
    })
    await run.step('prune email_log', async () => {
      const r = await pruneInBatches(service, 'email_log', q => q.lt('created_at', iso(EMAIL_LOG_DAYS)))
      run.result.emailLogPurged = r.deleted
      if (r.truncated) remaining.push('email_log')
    })
    await run.step('prune ai_usage_log', async () => {
      const r = await pruneInBatches(service, 'ai_usage_log', q => q.lt('created_at', iso(AI_USAGE_DAYS)))
      run.result.aiUsagePurged = r.deleted
      if (r.truncated) remaining.push('ai_usage_log')
    })
    await run.step('prune cron_run_history', async () => {
      const r = await pruneInBatches(service, 'cron_run_history', q => q.lt('created_at', iso(CRON_HISTORY_DAYS)))
      run.result.cronHistoryPurged = r.deleted
      if (r.truncated) remaining.push('cron_run_history')
    })
    await run.step('downsample snapshot history', async () => {
      const { data, error } = await service.rpc('prune_snapshot_history', { p_keep_daily_days: SNAPSHOT_DAILY_KEEP_DAYS })
      if (error) throw new Error(error.message)
      run.result.snapshotsDownsampled = data ?? null
    })

    // A table that ran out of batch/time budget is not a failure — tomorrow's run continues — but it is
    // worth seeing in the result and the run history.
    if (remaining.length) run.result.moreRemaining = remaining

    const { body, status } = await run.finish()
    return NextResponse.json(body, { status })
  } catch (err) {
    console.error('Notification cleanup cron error:', err)
    await alertCronFailure(createServiceClient(), 'notification-cleanup', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

export const GET = POST
