export const runtime = 'nodejs'
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

// Retention for the two append-only tables this fix round introduced or relied on.
//
// FIX (Notifications & email fix round): nothing ever deleted a notification. Every project event
// fans out to up to 25 recipients, so `notifications` only grew, and its only index was partial
// (read = false), leaving the bell's list query to filter an ever-larger table. Read notifications
// are kept 90 days (long enough to scroll back through a project's history); anything older than
// 180 days is dropped even if it was never opened — an unread notification about an event half a
// year ago is not actionable. email_log (delivery/bounce tracking) is kept 180 days.

// SCHEDULING: crons are triggered by the external scopegov-cron-worker (vercel.json no longer lists
// them), so this endpoint does nothing until the worker calls it — daily, e.g. 02:30 UTC:
//   POST /api/cron/notification-cleanup   (Authorization: Bearer $CRON_SECRET)
//
// FIX (deep audit, notifications/search re-pass): this comment used to say
// 'notification-cleanup' was deliberately left OUT of EXPECTATIONS in
// cron-heartbeat-watchdog/route.ts until the worker was confirmed to call
// it, "since registering it before it is scheduled would alert on every
// deploy" — but a later round (cron + portal audit round 2, closing
// heartbeat gaps across section 17) registered it there without coming
// back to update this warning, so the two files have been contradicting
// each other. cron_heartbeats has no seed row for any cron and the
// watchdog gives a never-seen cron no grace period ("no row at all reads
// the same as stale... needs a human, not a free pass") — so if the
// external worker's schedule was never actually updated to include this
// route, ops has been getting a false "never ran" page roughly hourly
// (the alert's own cooldown) ever since that round shipped.
// Kept registered rather than pulled back out: silently dropping
// heartbeat coverage risks masking a real failure later, which is worse
// than a loud, cooldown-limited false alarm now. MANUAL VERIFICATION
// NEEDED: confirm the scopegov-cron-worker schedule actually includes
// `notification-cleanup` (same category of external-scheduling check
// already flagged for the GitHub Actions CRON_SECRET/APP_BASE_URL
// secrets) — if it doesn't, add it there rather than removing the
// EXPECTATIONS entry.

const READ_RETENTION_DAYS = 90
const ANY_RETENTION_DAYS  = 180
const EMAIL_LOG_DAYS      = 180

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient() as any
  try {
    const now = Date.now()
    const iso = (days: number) => new Date(now - days * 86400000).toISOString()

    const { error: readErr, count: readCount } = await service
      .from('notifications').delete({ count: 'exact' })
      .eq('read', true).lt('created_at', iso(READ_RETENTION_DAYS))
    if (readErr) console.error('Read-notification purge failed:', readErr.message)

    const { error: oldErr, count: oldCount } = await service
      .from('notifications').delete({ count: 'exact' })
      .lt('created_at', iso(ANY_RETENTION_DAYS))
    if (oldErr) console.error('Old-notification purge failed:', oldErr.message)

    const { error: logErr, count: logCount } = await service
      .from('email_log').delete({ count: 'exact' })
      .lt('created_at', iso(EMAIL_LOG_DAYS))
    if (logErr) console.error('email_log purge failed:', logErr.message)

    const failed = !!(readErr || oldErr || logErr)
    const result = {
      readPurged: readCount || 0, oldPurged: oldCount || 0, emailLogPurged: logCount || 0,
    }
    // A failed purge must not refresh the heartbeat — the watchdog should page instead.
    if (!failed) await recordCronHeartbeat(service, 'notification-cleanup', result)
    return NextResponse.json({ ok: !failed, ...result }, { status: failed ? 207 : 200 })
  } catch (err) {
    console.error('Notification cleanup cron error:', err)
    await alertCronFailure(createServiceClient(), 'notification-cleanup', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

export const GET = POST
