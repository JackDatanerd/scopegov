// lib/utils/retention.ts
//
// Batched retention deletes for the daily housekeeping crons.
//
// FIX (cron/portal audit round 3): notification-cleanup issued one unbounded
// `DELETE ... WHERE created_at < cutoff` per table. On the first run against a table that had never been
// pruned (notifications had grown for months; ai_usage_log had never been pruned at all) that is a single
// statement over millions of rows — long enough to hit the database's statement timeout, roll back, and
// fail identically every night. This deletes in bounded id batches, under a wall-clock budget, and reports
// whether it ran out of budget so the caller can say "more remains, tomorrow continues" instead of
// pretending it finished.

export interface PruneOptions {
  /** Rows per DELETE. PostgREST caps a response at 1000 rows, and the id list rides in the URL. */
  batch?: number
  /** Hard ceiling on batches per call (batch * maxBatches rows at most). */
  maxBatches?: number
  /** Stop starting new batches after this many ms. */
  budgetMs?: number
  idColumn?: string
}

export interface PruneResult { deleted: number; truncated: boolean }

/**
 * Deletes every row of `table` matching `applyFilter` in id batches.
 * `applyFilter` receives a select builder and must return it with its filters applied, e.g.
 *   pruneInBatches(service, 'notifications', q => q.eq('read', true).lt('created_at', cutoff))
 * Throws on the first database error (callers run it inside CronRun.step).
 */
export async function pruneInBatches(
  service: any, table: string, applyFilter: (q: any) => any, opts: PruneOptions = {},
): Promise<PruneResult> {
  const batch = Math.min(Math.max(opts.batch ?? 500, 1), 1000)
  const maxBatches = opts.maxBatches ?? 200
  const budgetMs = opts.budgetMs ?? 60_000
  const idCol = opts.idColumn ?? 'id'
  const startedAt = Date.now()
  let deleted = 0

  for (let i = 0; i < maxBatches; i++) {
    if (Date.now() - startedAt > budgetMs) return { deleted, truncated: true }
    const { data, error } = await applyFilter(service.from(table).select(idCol)).limit(batch)
    if (error) throw new Error(`${table} prune select: ${error.message}`)
    const ids = (data || []).map((r: any) => r[idCol])
    if (ids.length === 0) return { deleted, truncated: false }

    const { error: delErr } = await service.from(table).delete().in(idCol, ids)
    if (delErr) throw new Error(`${table} prune delete: ${delErr.message}`)
    deleted += ids.length
    if (ids.length < batch) return { deleted, truncated: false }
  }
  return { deleted, truncated: true }
}
