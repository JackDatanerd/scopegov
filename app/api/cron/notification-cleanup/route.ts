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
// Once it is scheduled, add `'notification-cleanup': 27` to EXPECTATIONS in
// cron-heartbeat-watchdog/route.ts so a dead run pages ops. It is deliberately NOT registered there
// yet: the watchdog pages on "never recorded", so registering it before it is scheduled would alert
// on every deploy.

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
