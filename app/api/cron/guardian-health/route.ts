export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

function verifyCronSecret(r: NextRequest) {
  return r.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
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
      // Alert ops — in production this would hit PagerDuty/Slack
      console.error(`[GUARDIAN ALERT] Classification failure rate: ${(rate * 100).toFixed(1)}% (${failed}/${total} in last 15 min)`)
      // Could also POST to a Slack webhook here
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
      console.error(`[GUARDIAN ALERT] ${unresolvedCount} unresolved classification failures older than 24h`)
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
