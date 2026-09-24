// lib/utils/cron-run.ts
//
// FIX (cron audit round 2, section 17 — systemic). Three reliability problems were
// shared by nearly every cron under app/api/cron/*:
//
//  1. Swallowed query errors. supabase-js never throws on a database error — it
//     returns { data: null, error }. Most crons destructured only `data`, so a
//     failed main SELECT looked identical to "nothing to do", the run finished,
//     and recordCronHeartbeat() wrote a healthy heartbeat for a run that did no
//     work. (co-stall spent months in exactly this state.) `mustSelect` /
//     `fetchAll` throw instead, so the failure reaches the cron's catch block,
//     the ops alert and the missing-heartbeat watchdog.
//
//  2. A silent row cap. PostgREST truncates every response at `max_rows`
//     (1000 on Supabase by default) WITHOUT an error. Any unpaginated cron query
//     simply never saw row 1001+. `fetchAll` pages with .range().
//
//  3. No isolation between steps. payment-overdue runs six independent scans in one
//     try block, so a failure in the first (least important) one skipped billing
//     enforcement for the day. `CronRun.step` isolates each step, records what
//     failed, and `finish` turns any failure into a loud (alerting, heartbeat-less)
//     result instead of a green one.

import { alertCronFailure } from '@/lib/utils/cron-alert'
import { fetchAll } from '@/lib/utils/fetch-all'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

/** Unwrap a single supabase-js result, throwing (with a label) if it carries an error. */
export function mustData<T>(label: string, res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) throw new Error(`${label}: ${res.error.message}`)
  return res.data
}

export { fetchAll }

export class CronRun {
  private failures: string[] = []
  private rowFailures: string[] = []
  readonly result: Record<string, unknown> = {}

  private readonly startedAt = Date.now()

  constructor(private service: any, readonly name: string) {}

  /** Run one independent step. A throw is recorded (and logged) but never aborts sibling steps. */
  async step(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (e: any) {
      const msg = `${label}: ${e?.message || String(e)}`
      console.error(`[cron:${this.name}] step failed — ${msg}`)
      this.failures.push(msg)
    }
  }

  /**
   * A single row/document that failed while its siblings were fine (one bad email, one lost race
   * that threw). Logged and surfaced in the ops alert, but the run still counts as having run —
   * one poison row must not permanently withhold the heartbeat for everything else.
   */
  rowError(label: string, e: unknown): void {
    const msg = `${label}: ${(e as any)?.message || String(e)}`
    console.error(`[cron:${this.name}] row failed — ${msg}`)
    if (this.rowFailures.length < 20) this.rowFailures.push(msg)
  }

  get failed(): boolean { return this.failures.length > 0 }

  /**
   * Success -> heartbeat + { ok: true, ...result }. Any failed step -> ops alert, NO heartbeat (so the
   * watchdog also notices a cron that is failing on every run), HTTP 500.
   */
  async finish(): Promise<{ body: Record<string, unknown>; status: number }> {
    if (this.failures.length === 0) {
      if (this.rowFailures.length > 0) {
        // history:false — the run is recorded once, as a success carrying its rowErrors, below.
        await alertCronFailure(this.service, this.name, new Error(`Completed with row-level failures: ${this.rowFailures.join(' | ')}`), undefined, { history: false })
      }
      await recordCronHeartbeat(
        this.service, this.name,
        this.rowFailures.length ? { ...this.result, rowErrors: this.rowFailures } : this.result,
        { durationMs: Date.now() - this.startedAt },
      )
      return { body: { ok: true, ...this.result, ...(this.rowFailures.length ? { rowErrors: this.rowFailures } : {}) }, status: 200 }
    }
    await alertCronFailure(this.service, this.name, new Error(this.failures.join(' | ')), undefined, { durationMs: Date.now() - this.startedAt, result: this.result })
    return { body: { ok: false, ...this.result, errors: this.failures }, status: 500 }
  }
}
