export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { sendEmail } from '@/lib/email/send'
import { systemFrom } from '@/lib/email/from'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

// FIX (build, cron section): this whole route detected real problems
// (elevated classification-failure rate, unresolved failures sitting for
// 24h+) but only ever `console.error`d them — literally commented "Could
// also POST to a Slack webhook here". Nobody was actually paged. This
// isn't scoped to a single workspace (it's a platform-wide health check
// across every workspace's guardian_checks), so it can't go through the
// normal per-workspace notification system — it needs its own ops
// recipient. OPS_ALERT_EMAIL is optional; if unset this still degrades to
// the previous console.error-only behavior rather than crashing the cron.

// FIX (cron audit, section 17 — closing pass): returns whether the send
// actually succeeded. `shouldAlert` below used to mark the cooldown as
// "sent" the instant it decided to alert — before this function even
// attempted delivery — so a Resend failure (bad API key, an outage) still
// consumed the full cooldown window as if the page had gone out. The
// entire point of this route (per the FIX above it) is that someone
// actually gets paged; silently eating the next 1-6 hours of alerts on a
// delivery failure defeats that just as thoroughly as never emailing at
// all did before this route existed.
async function alertOps(subject: string, lines: string[]): Promise<boolean> {
  const to = process.env.OPS_ALERT_EMAIL
  if (!to) return false
  // FIX (Notifications & email fix round): the try/catch that used to wrap
  // this could never fire — Resend's SDK resolves `{ error }` instead of
  // throwing — so this always returned true and the cooldown above was
  // consumed by sends that never went out, exactly what the note above says
  // it prevents. sendEmail() reports the real outcome.
  const res = await sendEmail({
    from:    systemFrom('ScopeGov Ops'),
    to,
    subject: `[Guardian Health] ${subject}`,
    html: `<div style="font-family:monospace;white-space:pre-wrap;">${lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\n')}</div>`,
  })
  if (!res.ok) console.error('Guardian health ops alert email failed:', res.error)
  return res.ok
}

// FIX (cron audit, section 17): this route runs every 15 minutes and had
// no cooldown on either alert — an issue that stays elevated/unresolved
// re-triggered a fresh ops email every single run for as long as it lasted,
// unlike every other recurring notification in this codebase. `key` is a
// stable per-alert-type identifier (this route only has two); `cooldownMs`
// caps how often that specific alert can actually fire an email, while the
// console.error above it still logs every run either way, so nothing about
// server-side visibility is lost — only the inbox spam is.
//
// FIX (cron audit, section 17 — closing pass): split into a read-only
// cooldown check and a separate `markAlerted` write, called only after
// alertOps() reports success — see that function's comment. A failed send
// now leaves the cooldown state untouched, so the very next run (15
// minutes later) tries again instead of going quiet for up to 6 hours.
async function isOnCooldown(service: any, key: string, cooldownMs: number): Promise<boolean> {
  const { data } = await service.from('ops_alert_state').select('last_sent_at').eq('key', key).maybeSingle()
  return !!(data && Date.now() - new Date(data.last_sent_at).getTime() < cooldownMs)
}

async function markAlerted(service: any, key: string): Promise<void> {
  await service.from('ops_alert_state').upsert({ key, last_sent_at: new Date().toISOString() })
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service  = createServiceClient()
    const since15m = new Date(Date.now() - 15 * 60000).toISOString()

    const { data: recent, error: recentErr } = await (service as any)
      .from('guardian_checks')
      .select('id, classification_failed')
      .gte('created_at', since15m)
      .eq('is_duplicate', false)
    if (recentErr) throw new Error(`guardian-health select: ${recentErr.message}`)

    const total  = (recent || []).length
    const failed = (recent || []).filter((c: any) => c.classification_failed).length
    const rate   = total > 0 ? failed / total : 0

    if (rate > 0.01 && total >= 5) {
      const msg = `Classification failure rate: ${(rate * 100).toFixed(1)}% (${failed}/${total} in last 15 min)`
      console.error(`[GUARDIAN ALERT] ${msg}`)
      if (!(await isOnCooldown(service, 'guardian_health:elevated_failure_rate', 60 * 60000))) {
        if (await alertOps('Elevated classification failure rate', [msg]))
          await markAlerted(service, 'guardian_health:elevated_failure_rate')
      }
    }

    // Alert on unresolved failures > 24h
    const since24h = new Date(Date.now() - 24 * 3600000).toISOString()
    const { count: unresolvedCount } = await (service as any)
      .from('guardian_checks')
      .select('id', { count: 'exact', head: true })
      .eq('classification_failed', true)
      .lt('created_at', since24h)
      .eq('outcome', 'pending')

    if ((unresolvedCount || 0) > 0) {
      const msg = `${unresolvedCount} unresolved classification failures older than 24h`
      console.error(`[GUARDIAN ALERT] ${msg}`)
      if (!(await isOnCooldown(service, 'guardian_health:unresolved_failures', 6 * 3600000))) {
        if (await alertOps('Unresolved classification failures', [msg]))
          await markAlerted(service, 'guardian_health:unresolved_failures')
      }
    }

    await recordCronHeartbeat(service, 'guardian-health', { total, failed })
    return NextResponse.json({ ok: true, total, failed, rate: rate.toFixed(3) })
  } catch (err) {
    console.error('Guardian health check error:', err)
    await alertCronFailure(createServiceClient(), 'guardian-health', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. Exporting GET as an alias makes both invocation paths work.
//
// FIX (cron audit, section 17 re-pass): the paragraph this replaces claimed
// sow-stall/co-stall/guardian-health were "now scheduled directly in
// vercel.json" — vercel.json is actually `{}` (confirmed on disk); the
// primary scheduler is the external scopegov-cron-worker (Cloudflare
// Worker, not in this repo), with .github/workflows/vercel-crons.yml kept
// as a redundant trigger. That comment was stale and pointed anyone
// debugging "why didn't this cron run" at a file that controls nothing.
export const GET = POST
