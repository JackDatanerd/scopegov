export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

// Project purge: hard-delete soft-deleted Draft/Intake projects > 30 days
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service  = createServiceClient()
    const cutoff   = new Date(Date.now() - 30 * 86400000).toISOString()

    const { data: purged } = await (service as any)
      .from('projects')
      .delete()
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff)
      .select('id')

    console.log(`[PROJECT PURGE] Hard-deleted ${purged?.length || 0} projects soft-deleted > 30 days ago`)
    return NextResponse.json({ ok: true, purged: purged?.length || 0 })
  } catch (err) {
    console.error('Project purge cron error:', err)
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
