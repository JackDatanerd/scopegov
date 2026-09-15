export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { Resend } from 'resend'

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
let _resend: Resend | null = null
function resendClient(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

async function alertOps(subject: string, lines: string[]) {
  const to = process.env.OPS_ALERT_EMAIL
  if (!to) return
  try {
    await resendClient().emails.send({
      from:    `ScopeGov Ops <${process.env.RESEND_FROM_EMAIL}>`,
      to,
      subject: `[Guardian Health] ${subject}`,
      html: `<div style="font-family:monospace;white-space:pre-wrap;">${lines.map(l => l.replace(/</g, '&lt;')).join('\n')}</div>`,
    })
  } catch (e) { console.error('Guardian health ops alert email failed:', e) }
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service  = createServiceClient()
    const since15m = new Date(Date.now() - 15 * 60000).toISOString()

    const { data: recent } = await (service as any)
      .from('guardian_checks')
      .select('id, classification_failed')
      .gte('created_at', since15m)
      .eq('is_duplicate', false)

    const total  = (recent || []).length
    const failed = (recent || []).filter((c: any) => c.classification_failed).length
    const rate   = total > 0 ? failed / total : 0

    if (rate > 0.01 && total >= 5) {
      const msg = `Classification failure rate: ${(rate * 100).toFixed(1)}% (${failed}/${total} in last 15 min)`
      console.error(`[GUARDIAN ALERT] ${msg}`)
      await alertOps('Elevated classification failure rate', [msg])
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
      await alertOps('Unresolved classification failures', [msg])
    }

    return NextResponse.json({ ok: true, total, failed, rate: rate.toFixed(3) })
  } catch (err) {
    console.error('Guardian health check error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. The 3 sub-hourly jobs (sow-stall, co-stall, guardian-health) are
// triggered by the GitHub Actions workflow via POST, which still works.
// Exporting GET as an alias makes both invocation paths work.
export const GET = POST
