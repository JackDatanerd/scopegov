import { recordCronRunHistory } from '@/lib/utils/cron-history'

// lib/utils/cron-heartbeat.ts
//
// FEATURE (cron audit, section 17 — feature gap, closing pass): see
// migration 058's note. alertCronFailure (lib/utils/cron-alert.ts) only
// fires from inside a run that actually started and threw — it has no way
// to notice a cron that simply never fired (dropped from vercel.json,
// CRON_SECRET drifted, a Vercel platform outage). Call this once, right
// before a cron's success response, so app/api/cron/cron-heartbeat-
// watchdog has something to compare against. Deliberately fire-and-forget
// from the caller's point of view (never throws) — a heartbeat write
// failing must never turn an otherwise-successful cron run into a 500.
//
// FIX (cron/portal audit round 3): `.upsert()` returns { error } rather than throwing, so the try/catch
// below only ever caught a network-level throw — a failed heartbeat write (RLS, a dropped table, a
// constraint) was silently ignored and the watchdog would then page about a cron that had in fact
// succeeded. The error is now read and logged. Every success also appends a cron_run_history row
// (lib/utils/cron-history.ts) so a run's counters and duration outlive the next heartbeat.
export async function recordCronHeartbeat(
  service: any, cronName: string, result?: Record<string, unknown>,
  opts?: { durationMs?: number },
): Promise<void> {
  try {
    const { error } = await service.from('cron_heartbeats').upsert({
      cron_name:   cronName,
      last_ok_at:  new Date().toISOString(),
      last_result: result || null,
    })
    if (error) console.error(`Cron heartbeat write failed for ${cronName}:`, error.message)
  } catch (e) {
    console.error(`Cron heartbeat write failed for ${cronName}:`, e)
  }
  await recordCronRunHistory(service, cronName, { ok: true, durationMs: opts?.durationMs, result: result || null })
}
