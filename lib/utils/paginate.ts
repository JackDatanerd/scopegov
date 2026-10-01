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

// ── Large `.in()` filters ────────────────────────────────────────────────────
// FIX (section-7 independent pass, B4): `.in('id', ids)` puts every id in the request URL (~37 bytes each). A
// restricted member's project_members rows are never removed when a project completes or archives, so a long-tenured
// member's list only grows, and past a couple of hundred projects the URL exceeds gateway limits and the Dashboard /
// Projects list errored for that user. Large id lists are therefore split into chunks (same size contract-value.ts
// already uses for its milestone lookup) and the per-chunk results merged.
export const ID_FILTER_CHUNK = 100

export function chunkIds<T>(ids: readonly T[], size = ID_FILTER_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * fetchPaged over an id list: one paged fetch per chunk of ids, merged and re-sorted with `compare` (the SQL ORDER BY
 * can only apply within a chunk). `total` is the sum of the chunks' exact counts; `truncated` is true when any chunk —
 * or the merged result — exceeds `maxRows`.
 */
export async function fetchPagedIn<T = any>(
  ids: readonly string[],
  build: (chunk: string[], from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { maxRows: number; pageSize?: number },
  compare: (a: T, b: T) => number,
): Promise<PagedRows<T>> {
  const chunks = chunkIds(ids)
  if (chunks.length === 0) return { rows: [], total: 0, truncated: false }
  const rows: T[] = []
  let total = 0
  let truncated = false
  for (const chunk of chunks) {
    const page = await fetchPaged<T>((from, to) => build(chunk, from, to), opts)
    rows.push(...page.rows)
    total += page.total
    if (page.truncated) truncated = true
  }
  rows.sort(compare)
  if (rows.length > opts.maxRows) { rows.length = opts.maxRows; truncated = true }
  return { rows, total, truncated }
}

/**
 * Run a non-paged read once per chunk of ids and concatenate the rows. A chunk that errors contributes nothing, the
 * same as the single `{ data = [] }` read it replaces; the first error is returned so a caller can still log it.
 */
export async function queryInChunks<T = any>(
  ids: readonly string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error?: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const data: T[] = []
  let error: { message: string } | null = null
  for (const chunk of chunkIds(ids)) {
    const res = await run(chunk)
    if (res.error && !error) error = res.error
    data.push(...(res.data || []))
  }
  return { data, error }
}
