export const runtime = 'nodejs'
// Loops every workspace; each does several paged reads (see scope-health.ts).
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'
import { computeScopeHealth } from '@/lib/reports/scope-health'
import { fetchAll } from '@/lib/utils/cron-run'

// Persists the day's scope-health snapshot (history / trend). The numbers
// themselves come from lib/reports/scope-health.ts — the SAME computation the
// Portfolio page runs live for its headline tiles — so a snapshot can never
// disagree with what the page showed that day.
//
// Portfolio deep audit fixes here:
//  - A failed read used to be swallowed (`res.data || []`) and an all-zero
//    snapshot upserted over the day's good row. computeScopeHealth throws on
//    any read error, so a failed workspace writes NOTHING and is reported.
//  - The upsert's own `{ error }` was never inspected, so a rejected write
//    counted as `processed`. It is now checked.
//  - Reads inside computeScopeHealth are paged (PostgREST caps a plain select at
//    1000 rows) — but the top-level workspace list this file itself queries was
//    NOT (FIX, cron audit section 17 re-pass): past ~1000 active workspaces the
//    tail silently never got a snapshot, the exact bug reconciliation-rollup
//    found and fixed in its own project list — see that file's header comment.
//    Paged here the same way, with fetchAll.
//  - The dominant currency is chosen among in-progress projects, non-monetary
//    counts span every currency, exceptions on finished projects no longer
//    inflate at-risk — see scope-health.ts.
//  - Partial failure now returns 207 with `ok: false` instead of a green 200.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const snapshotDate = new Date().toISOString().split('T')[0]

    const workspaces = await fetchAll<{ id: string }>('scope-health workspaces select', (from, to) =>
      (service as any).from('workspaces')
        .select('id')
        .is('deleted_at', null)
        .order('id')
        .range(from, to))

    let processed = 0
    const errors: Array<{ workspaceId: string; error: string }> = []

    for (const ws of workspaces) {
      try {
        await rollupWorkspace(service, ws.id, snapshotDate)
        processed++
      } catch (e) {
        errors.push({ workspaceId: ws.id, error: e instanceof Error ? e.message : 'unknown' })
        console.error(`Scope-health rollup failed for workspace ${ws.id}:`, e)
      }
    }

    if (errors.length > 0) {
      await alertCronFailure(service, 'scope-health-rollup', new Error(
        `${errors.length} workspace(s) failed: ` + errors.slice(0, 10).map(e => `${e.workspaceId}: ${e.error}`).join(' | '))).catch(() => {})
    }
    await recordCronHeartbeat(service, 'scope-health-rollup', { processed, failed: errors.length })
    return NextResponse.json(
      { ok: errors.length === 0, processed, failed: errors.length, errors },
      { status: errors.length ? 207 : 200 },
    )
  } catch (err) {
    console.error('Scope-health rollup cron error:', err)
    await alertCronFailure(createServiceClient(), 'scope-health-rollup', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

async function rollupWorkspace(service: any, workspaceId: string, snapshotDate: string) {
  const h = await computeScopeHealth(service, workspaceId)

  const { error } = await service.from('scope_health_snapshots').upsert(
    {
      workspace_id: workspaceId,
      snapshot_date: snapshotDate,
      open_flags_count: h.openFlagsCount,
      open_flags_by_severity: h.openFlagsBySeverity,
      exceptions_count: h.exceptionsCount,
      exceptions_value_total: h.exceptionsValueTotal,
      contract_value_at_risk: h.contractValueAtRisk,
      stalled_sow_count: h.stalledSowCount,
      stalled_co_count: h.stalledCoCount,
      active_project_count: h.activeProjectCount,
      currency: h.currency,
    },
    { onConflict: 'workspace_id,snapshot_date' },
  )
  if (error) throw new Error(`snapshot upsert: ${error.message}`)
}

// Vercel Cron invokes the configured path with GET, not POST.
export const GET = POST
