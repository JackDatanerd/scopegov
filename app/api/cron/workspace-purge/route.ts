export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service  = createServiceClient()
  const cutoff7yr = new Date(Date.now() - 7 * 365 * 86400000).toISOString()

  const { data: candidates, error: findErr } = await (service as any)
    .from('workspaces')
    .select('id')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff7yr)

  if (findErr) {
    console.error('Workspace purge candidate lookup failed:', findErr)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }

  // FIX (cron audit, section 17): same root cause as project-purge — a
  // bulk `.delete()` straight against workspaces, with projects.workspace_id
  // (and sow_documents/change_orders/invoices/guardian_*/clients.workspace_id,
  // etc.) all ON DELETE RESTRICT, and `error` never checked. A soft-deleted
  // workspace still has every project it ever had (workspace delete only
  // blocks on an unsigned SOW — see app/api/workspace/delete/route.ts — it
  // never removes the workspace's projects), so this DELETE failed on
  // essentially every real workspace, silently, forever. purge_workspace()
  // (migration 019) purges every project first via purge_project(), then
  // the workspace-level tables, then the workspace row itself, atomically.
  let purgedCount = 0
  const failures: Array<{ id: string; error: string }> = []
  for (const w of (candidates || [])) {
    const { error: purgeErr } = await (service as any).rpc('purge_workspace', { p_workspace_id: w.id })
    if (purgeErr) {
      console.error(`Workspace purge failed for ${w.id}:`, purgeErr)
      failures.push({ id: w.id, error: purgeErr.message })
    } else {
      purgedCount++
    }
  }

  console.log(`[WORKSPACE PURGE] Hard-deleted ${purgedCount}/${(candidates || []).length} workspaces older than 7 years`)
  return NextResponse.json({
    ok: failures.length === 0,
    purged: purgedCount,
    failed: failures.length,
    ...(failures.length ? { failures } : {}),
  }, { status: failures.length ? 207 : 200 })
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. The 3 sub-hourly jobs (sow-stall, co-stall, guardian-health) are
// triggered by the GitHub Actions workflow via POST, which still works.
// Exporting GET as an alias makes both invocation paths work.
export const GET = POST
