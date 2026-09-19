// lib/utils/paginate.ts
//
// FIX (Reports & Audit re-pass #3): every "big read" in the reports/audit
// code used `.limit(MAX + 1)` and then compared `rows.length > MAX` to detect
// truncation. That can never work when PostgREST's server-side "Max rows"
// setting (Supabase default: 1000) is lower than MAX — the server silently
// returns at most 1000 rows no matter what `.limit()` asks for, so the
// `> MAX` check is false and the caller confidently presents a short result
// as complete. This helper pages with `.range()` in chunks that fit under
// the cap, uses the exact `count` from the first page to know when to stop
// (so it is correct even if the configured cap is smaller than expected),
// and surfaces read errors instead of swallowing them.

export interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
  count?: number | null
}

export interface PagedRows<T> {
  rows: T[]
  /** Exact number of rows matching the query (before the maxRows cap). */
  total: number
  /** True when `total` exceeds `maxRows` (rows were cut off). */
  truncated: boolean
}

export const SUPABASE_DEFAULT_MAX_ROWS = 1000

/**
 * @param build   Called with an inclusive [from, to] range; must return the
 *                query with `.range(from, to)` applied and a deterministic
 *                `.order()` — and must request `{ count: 'exact' }` on its
 *                select so the first page can report the true total.
 */
export async function fetchPaged<T = any>(
  build: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { maxRows: number; pageSize?: number },
): Promise<PagedRows<T>> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? SUPABASE_DEFAULT_MAX_ROWS, SUPABASE_DEFAULT_MAX_ROWS))
  const rows: T[] = []
  let total: number | null = null
  let offset = 0

  // Loop until we have maxRows rows, run out of rows, or (when the server
  // told us the total) have everything.
  while (rows.length < opts.maxRows) {
    const want = Math.min(pageSize, opts.maxRows - rows.length)
    const res = await build(offset, offset + want - 1)
    if (res.error) throw new Error(res.error.message || 'Query failed')
    if (total === null && typeof res.count === 'number') total = res.count
    const batch = res.data || []
    if (batch.length === 0) break
    rows.push(...batch)
    offset += batch.length
    if (total !== null && offset >= total) break
  }

  const finalTotal = total ?? rows.length
  return { rows, total: finalTotal, truncated: finalTotal > rows.length }
}

/** Throws on a Supabase `{ error }` result; returns `data` (never null). */
export function unwrap<T>(res: { data: T[] | null; error: { message: string } | null }, label: string): T[] {
  if (res.error) throw new Error(`${label}: ${res.error.message}`)
  return res.data || []
}
