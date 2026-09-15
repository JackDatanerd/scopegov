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

    const { data: candidates, error: findErr } = await (service as any)
      .from('projects')
      .select('id')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff)

    if (findErr) {
      console.error('Project purge candidate lookup failed:', findErr)
      return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
    }

    // FIX (cron audit, section 17): this used to be a single bulk
    // `.delete()` straight against the projects table. sow_documents,
    // change_orders, invoices, guardian_flags/checks, etc. all have a
    // project_id FK with no ON DELETE CASCADE (Postgres default is
    // RESTRICT), so any project with real content — anything past Draft,
    // i.e. every Intake+ project, since moving Draft->Intake creates a
    // sow_documents row — made that DELETE throw a foreign-key violation.
    // The old code only ever read `data` off the response, never `error`,
    // so the failure was invisible: it logged/returned `purged: 0` and
    // `ok: true` every single time, having purged nothing. Routing through
    // purge_project() (see migration 019) does the correctly-ordered
    // cascade explicitly, and errors are now surfaced instead of swallowed.
    let purgedCount = 0
    const failures: Array<{ id: string; error: string }> = []
    for (const p of (candidates || [])) {
      const { error: purgeErr } = await (service as any).rpc('purge_project', { p_project_id: p.id })
      if (purgeErr) {
        console.error(`Project purge failed for ${p.id}:`, purgeErr)
        failures.push({ id: p.id, error: purgeErr.message })
      } else {
        purgedCount++
      }
    }

    console.log(`[PROJECT PURGE] Hard-deleted ${purgedCount}/${(candidates || []).length} projects soft-deleted > 30 days ago`)
    return NextResponse.json({
      ok: failures.length === 0,
      purged: purgedCount,
      failed: failures.length,
      ...(failures.length ? { failures } : {}),
    }, { status: failures.length ? 207 : 200 })
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
