// lib/utils/cron-history.ts
//
// FEATURE (cron/portal audit round 3): cron_heartbeats keeps exactly one row per cron — the LAST success.
// That answers "has it run lately?" but nothing else: a cron that fails every third run, one whose runtime
// is creeping toward maxDuration, or one that has been finishing "ok" with row errors all week is
// invisible, because the evidence is overwritten by the next success. cron_run_history (migration 074)
// keeps a row per run — outcome, duration, the result counters, and the error text of a failed run —
// pruned to 60 days by notification-cleanup.
//
// Best-effort by design, exactly like recordCronHeartbeat: a history write must never turn a run into a
// failure (and must keep working before migration 074 is applied — the error is swallowed).

export interface CronRunHistoryEntry {
  ok: boolean
  durationMs?: number | null
  result?: Record<string, unknown> | null
  error?: string | null
}

export async function recordCronRunHistory(service: any, cronName: string, entry: CronRunHistoryEntry): Promise<void> {
  try {
    const { error } = await service.from('cron_run_history').insert({
      cron_name:   cronName,
      ok:          entry.ok,
      duration_ms: entry.durationMs ?? null,
      result:      entry.result ?? null,
      error:       entry.error ? String(entry.error).slice(0, 4000) : null,
    })
    if (error) console.error(`Cron run history write failed for ${cronName}:`, error.message)
  } catch (e) {
    console.error(`Cron run history write threw for ${cronName}:`, e)
  }
}
