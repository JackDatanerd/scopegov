export const runtime = 'nodejs'
// FEATURE (cron audit, section 17 — feature gap, closing pass): unbounded
// per-row fan-out with no pagination — same shape project-purge and
// payment-overdue/reconciliation-rollup already carry this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { collectAttachmentPaths, removeStoragePaths } from '@/lib/utils/storage-cleanup'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

// FIX (cron audit, section 17): this route was the one exception in the
// whole cron/ directory with no top-level try/catch — every other route
// here wraps its entire body so an unexpected throw (a bad env var,
// createServiceClient() itself failing, a transient network error on the
// very first query) is logged and turned into a clean 500 instead of an
// unhandled exception. This is also the one route doing irreversible hard
// deletes, which makes it the last place that safety net should be missing.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  try {
    const cutoff7yr = new Date(Date.now() - 7 * 365 * 86400000).toISOString()

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — traced
    // through from onboarding's logo-upload path): fetch logo_storage_path
    // now, while the row still exists — purge_workspace hard-deletes the
    // `workspaces` row itself, so this is the last point this is readable.
    const { data: candidates, error: findErr } = await (service as any)
      .from('workspaces')
      .select('id, logo_storage_path')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff7yr)
      .order('deleted_at', { ascending: true })
      .limit(50) // oldest first; each purge is heavy, the remainder is picked up on the next weekly run

    if (findErr) {
      console.error('Workspace purge candidate lookup failed:', findErr)
      // FEATURE (cron audit, section 17 — feature gap, closing pass): same
      // fix as project-purge's identical early return — this bypassed the
      // outer catch, so this failure mode was invisible outside Vercel logs.
      await alertCronFailure(service, 'workspace-purge', findErr).catch(() => {})
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
    // (migration 020) purges every project first via purge_project(), then
    // the workspace-level tables, then the workspace row itself, atomically.
    let purgedCount = 0
    const failures: Array<{ id: string; error: string }> = []
    for (const w of (candidates || [])) {
      // Same ordering as project-purge: list the evidence files BEFORE the rows
      // that reference them are deleted; skip (retry next run) if we can't.
      let filePaths: string[]
      try {
        filePaths = await collectAttachmentPaths(service, { workspaceId: w.id })
      } catch (e) {
        console.error(`Workspace purge skipped for ${w.id} — could not list its attachment files:`, e)
        failures.push({ id: w.id, error: `attachment lookup failed: ${e instanceof Error ? e.message : 'unknown'}` })
        continue
      }

      const { error: purgeErr } = await (service as any).rpc('purge_workspace', { p_workspace_id: w.id })
      if (purgeErr) {
        console.error(`Workspace purge failed for ${w.id}:`, purgeErr)
        failures.push({ id: w.id, error: purgeErr.message })
        continue
      }
      purgedCount++

      if (filePaths.length) {
        const r = await removeStoragePaths(service, filePaths)
        if (r.failed) console.error(`Workspace ${w.id}: ${r.failed} evidence file(s) could not be removed (non-fatal)`)
      }
      // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): the DB
      // row is gone at this point, but purge_workspace() never touched
      // Storage — the logo object this workspace uploaded (see
      // workspace/branding/logo/route.ts) was left behind in the public
      // `logos` bucket forever, unreferenced by anything. Best-effort,
      // same pattern the logo-upload route itself already uses for its
      // own stale-object cleanup: must never fail the purge, which has
      // already succeeded by this point.
      if (w.logo_storage_path) {
        const { error: removeErr } = await (service as any).storage.from('logos').remove([w.logo_storage_path])
        if (removeErr) console.error(`Logo cleanup failed for purged workspace ${w.id} (non-fatal):`, removeErr)
      }
      // FIX (deep audit, Workspace lifecycle + Onboarding re-pass):
      // users.active_workspace_id carries no FK to workspaces (checked —
      // there isn't one across any migration), so it can't be relied on to
      // cascade or null itself out here. workspace/delete's own
      // reassignment loop already runs at soft-delete time for every
      // member, so this only ever matters for the rare case that
      // best-effort step failed for someone 7 years ago and they never
      // switched since. Harmless today — getSession() already falls back
      // to the oldest remaining active membership regardless of this
      // column's value — but there's no reason to leave a reference to a
      // row that no longer exists lying around. Best-effort, must never
      // fail the purge.
      const { error: staleActiveErr } = await (service as any)
        .from('users').update({ active_workspace_id: null }).eq('active_workspace_id', w.id)
      if (staleActiveErr) console.error(`Stale active_workspace_id cleanup failed for purged workspace ${w.id} (non-fatal):`, staleActiveErr)
    }

    console.log(`[WORKSPACE PURGE] Hard-deleted ${purgedCount}/${(candidates || []).length} workspaces older than 7 years`)
    // A purge that fails (an unexpected FK, a storage error) used to surface only as a 207 body that
    // nobody reads, then retry silently every day. Page ops instead (cooldown-limited by alertCronFailure).
    if (failures.length > 0) {
      await alertCronFailure(service, 'workspace-purge', new Error(
        `Workspace purge: ${failures.length} item(s) failed — ` + failures.slice(0, 10).map(f => `${f.id}: ${f.error}`).join(' | '),
      )).catch(() => {})
    }
    await recordCronHeartbeat(service, 'workspace-purge', { purged: purgedCount, failed: failures.length })
    return NextResponse.json({
      ok: failures.length === 0,
      purged: purgedCount,
      failed: failures.length,
      ...(failures.length ? { failures } : {}),
    }, { status: failures.length ? 207 : 200 })
  } catch (err) {
    console.error('Workspace purge cron error:', err)
    await alertCronFailure(service, 'workspace-purge', err).catch(() => {})
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
