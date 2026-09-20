// lib/utils/fetch-all.ts
//
// PostgREST truncates every response at `max_rows` (1000 on Supabase by default) WITHOUT an error, so
// any unpaginated query silently never sees row 1001+. fetchAll pages with .range() and THROWS on a
// query error (supabase-js never throws on its own — it returns { data: null, error }).
// See lib/utils/cron-run.ts for how the crons use it.

const PAGE_SIZE = 1000
// Hard ceiling so a runaway table can never make a cron loop unboundedly.
const DEFAULT_MAX_ROWS = 50_000

type QueryResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>

/**
 * Fetch every row a query matches, page by page. `build(from, to)` must return the query WITH a
 * deterministic .order(...) (use the primary key) and `.range(from, to)` applied. The whole result is
 * collected before any caller mutates rows, so offset paging is stable.
 */
export async function fetchAll<T = any>(
  label: string,
  build: (from: number, to: number) => QueryResult<T>,
  maxRows: number = DEFAULT_MAX_ROWS,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const rows = data || []
    out.push(...rows)
    if (rows.length < PAGE_SIZE) return out
  }
  console.error(`[cron] ${label}: stopped at the ${maxRows}-row safety ceiling — remaining rows will be picked up on the next run`)
  return out
}
