export const runtime = 'nodejs'
// FEATURE (cron audit, section 17 — feature gap, closing pass): unbounded
// per-row fan-out (attachment lookup + storage removal per candidate) with
// no pagination — same shape payment-overdue/reconciliation-rollup already
// carry this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { collectAttachmentPaths, collectExecutedPdfPaths, removePurgedFiles } from '@/lib/utils/storage-cleanup'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

// Project purge: hard-delete soft-deleted Draft/Intake projects > 30 days
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  try {
    const cutoff   = new Date(Date.now() - 30 * 86400000).toISOString()

    const { data: candidates, error: findErr } = await (service as any)
      .from('projects')
      .select('id')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff)
      .order('deleted_at', { ascending: true })
      .limit(500) // oldest first; the remainder is picked up on the next daily run

    if (findErr) {
      console.error('Project purge candidate lookup failed:', findErr)
      // FEATURE (cron audit, section 17 — feature gap, closing pass): this
      // early return used to bypass the outer catch entirely, so a
      // candidate-lookup failure — the one failure mode that means this
      // cron did nothing at all that day — was invisible outside Vercel
      // logs, same gap as every other bare console.error this pass closes.
      await alertCronFailure(service, 'project-purge', findErr).catch(() => {})
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
    let filesRemoved = 0
    let filesFailed = 0
    const failures: Array<{ id: string; error: string }> = []
    for (const p of (candidates || [])) {
      // Attachment files are only discoverable through their DB rows, which the
      // purge deletes — collect the paths first, and skip this project (retry
      // next run) if we can't, rather than orphan its files.
      let filePaths: string[]
      let pdfPaths: string[]
      try {
        filePaths = await collectAttachmentPaths(service, { projectId: p.id })
        // Executed SOW/CO PDFs live in the private `pdfs` bucket (migration 061) — same ordering rule.
        pdfPaths = await collectExecutedPdfPaths(service, { projectId: p.id })
      } catch (e) {
        console.error(`Project purge skipped for ${p.id} — could not list its attachment files:`, e)
        failures.push({ id: p.id, error: `attachment lookup failed: ${e instanceof Error ? e.message : 'unknown'}` })
        continue
      }

      const { error: purgeErr } = await (service as any).rpc('purge_project', { p_project_id: p.id })
      if (purgeErr) {
        console.error(`Project purge failed for ${p.id}:`, purgeErr)
        failures.push({ id: p.id, error: purgeErr.message })
        continue
      }
      purgedCount++

      // Best-effort: the project is already gone, a stuck file must not fail the run.
      if (filePaths.length || pdfPaths.length) {
        const r = await removePurgedFiles(service, filePaths, pdfPaths)
        filesRemoved += r.removed
        filesFailed += r.failed
      }
    }

    console.log(`[PROJECT PURGE] Hard-deleted ${purgedCount}/${(candidates || []).length} projects soft-deleted > 30 days ago`)
    // A purge that fails (an unexpected FK, a storage error) used to surface only as a 207 body that
    // nobody reads, then retry silently every day. Page ops instead (cooldown-limited by alertCronFailure).
    if (failures.length > 0) {
      await alertCronFailure(service, 'project-purge', new Error(
        `Project purge: ${failures.length} item(s) failed — ` + failures.slice(0, 10).map(f => `${f.id}: ${f.error}`).join(' | '),
      )).catch(() => {})
    }
    await recordCronHeartbeat(service, 'project-purge', { purged: purgedCount, failed: failures.length })
    return NextResponse.json({
      ok: failures.length === 0,
      purged: purgedCount,
      filesRemoved,
      ...(filesFailed ? { filesFailed } : {}),
      failed: failures.length,
      ...(failures.length ? { failures } : {}),
    }, { status: failures.length ? 207 : 200 })
  } catch (err) {
    console.error('Project purge cron error:', err)
    await alertCronFailure(service, 'project-purge', err).catch(() => {})
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
