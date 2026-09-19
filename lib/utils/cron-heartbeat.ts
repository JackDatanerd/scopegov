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
export async function recordCronHeartbeat(
  service: any, cronName: string, result?: Record<string, unknown>,
): Promise<void> {
  try {
    await service.from('cron_heartbeats').upsert({
      cron_name:   cronName,
      last_ok_at:  new Date().toISOString(),
      last_result: result || null,
    })
  } catch (e) {
    console.error(`Cron heartbeat write failed for ${cronName}:`, e)
  }
}
