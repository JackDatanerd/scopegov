// tests/helpers/fake-supabase.ts
//
// A small in-memory stand-in for the supabase-js query builder, good enough to drive the cron routes and the
// portal handlers end-to-end in unit tests (round 3 of the cron/portal audit: until now only two crons had any
// test, each with its own throwaway fake, and the bugs found this round — swallowed write errors, fragile
// windows, missing repairs — are exactly what such tests catch).
//
// Rows are plain objects; embedded relations (`projects(...)`, `billing(...)`) are simply nested objects the test
// puts on the row, and a filter on `projects.deleted_at` reads through them. `select()` column lists are ignored
// (whole rows come back). It supports: select/insert/update/delete/upsert, eq/neq/in/lt/lte/gt/gte/is/not/like/
// ilike/or(simple), order/limit/range, single/maybeSingle, count + head, `metadata->>key` paths, rpc handlers,
// storage remove, and per-table/per-operation error injection.

export type Row = Record<string, any>
export interface FakeErrorRule { table: string; op: 'select' | 'insert' | 'update' | 'delete' | 'upsert'; message?: string; code?: string; when?: (payload: any) => boolean; times?: number }
export interface FakeOptions {
  errors?: FakeErrorRule[]
  /** Return true if inserting `row` into `table` violates a unique constraint (=> error code 23505). */
  unique?: (table: string, row: Row, existing: Row[]) => boolean
  rpc?: Record<string, (args: any) => { data?: any; error?: { message: string } | null }>
}

let idSeq = 0
const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

function getPath(row: Row, path: string): any {
  if (path.includes('->>')) {
    const [col, key] = path.split('->>')
    const v = getPath(row, col)?.[key]
    return v == null ? v : String(v)
  }
  let cur: any = row
  for (const part of path.split('.')) { if (cur == null) return undefined; cur = cur[part] }
  return cur
}

const cmp = (a: any, b: any) => {
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1
  const x = a instanceof Date ? a.toISOString() : a, y = b instanceof Date ? b.toISOString() : b
  return x < y ? -1 : x > y ? 1 : 0
}

export function createFakeSupabase(initial: Record<string, Row[]> = {}, options: FakeOptions = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(initial)) tables[k] = clone(v)
  const errorRules = (options.errors || []).map(r => ({ ...r, left: r.times ?? Infinity }))
  const calls: Array<{ table: string; op: string; payload?: any }> = []
  const removed: Array<{ bucket: string; paths: string[] }> = []
  const rpcCalls: Array<{ name: string; args: any }> = []

  const rowsOf = (t: string) => (tables[t] ||= [])

  function injected(table: string, op: string, payload: any) {
    const rule = errorRules.find(r => r.table === table && r.op === op && r.left > 0 && (!r.when || r.when(payload)))
    if (!rule) return null
    rule.left--
    return { message: rule.message || `injected ${op} failure on ${table}`, code: rule.code }
  }

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: any = null
    let returning = false
    let head = false
    let wantCount = false
    let onConflict: string | null = null
    const preds: Array<(r: Row) => boolean> = []
    let order: Array<{ col: string; asc: boolean }> = []
    let lim: number | null = null
    let rng: [number, number] | null = null
    let mode: 'many' | 'single' | 'maybe' = 'many'

    const add = (fn: (r: Row) => boolean) => { preds.push(fn); return b }

    const b: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (op === 'select') op = 'select'; else returning = true
        if (opts?.count) wantCount = true
        if (opts?.head) head = true
        return b
      },
      insert(p: any) { op = 'insert'; payload = p; return b },
      update(p: any) { op = 'update'; payload = p; return b },
      delete(_o?: any) { op = 'delete'; return b },
      upsert(p: any, o?: { onConflict?: string }) { op = 'upsert'; payload = p; onConflict = o?.onConflict ?? null; return b },
      eq: (c: string, v: any) => add(r => { const x = getPath(r, c); return x === v || (x != null && v != null && String(x) === String(v)) }),
      neq: (c: string, v: any) => add(r => getPath(r, c) !== v),
      in: (c: string, vs: any[]) => add(r => vs.includes(getPath(r, c))),
      lt: (c: string, v: any) => add(r => getPath(r, c) != null && cmp(getPath(r, c), v) < 0),
      lte: (c: string, v: any) => add(r => getPath(r, c) != null && cmp(getPath(r, c), v) <= 0),
      gt: (c: string, v: any) => add(r => getPath(r, c) != null && cmp(getPath(r, c), v) > 0),
      gte: (c: string, v: any) => add(r => getPath(r, c) != null && cmp(getPath(r, c), v) >= 0),
      is: (c: string, v: any) => add(r => (v === null ? getPath(r, c) == null : getPath(r, c) === v)),
      not: (c: string, o: string, v: any) => add(r => {
        const x = getPath(r, c)
        if (o === 'is') return v === null ? x != null : x !== v
        if (o === 'in') return !String(v).replace(/[()"]/g, '').split(',').includes(String(x))
        if (o === 'like') return !new RegExp('^' + String(v).replace(/%/g, '.*') + '$').test(String(x ?? ''))
        return x !== v
      }),
      // .or('a.eq.1,b.is.null') filters are NOT evaluated (too varied to fake) — a test that depends on one
      // should assert on the rows it seeded rather than on that filter.
      or: (_expr: string) => b,
      like: (c: string, p: string) => add(r => new RegExp('^' + p.replace(/%/g, '.*') + '$').test(String(getPath(r, c) ?? ''))),
      ilike: (c: string, p: string) => add(r => new RegExp('^' + p.replace(/%/g, '.*') + '$', 'i').test(String(getPath(r, c) ?? ''))),
      order(c: string, o?: { ascending?: boolean }) { order.push({ col: c, asc: o?.ascending !== false }); return b },
      limit(n: number) { lim = n; return b },
      range(a: number, z: number) { rng = [a, z]; return b },
      maybeSingle() { mode = 'maybe'; return b },
      single() { mode = 'single'; return b },
      then(resolve: any, reject: any) { return run().then(resolve, reject) },
    }

    async function run(): Promise<any> {
      calls.push({ table, op, payload: clone(payload) })
      const inj = injected(table, op, payload)
      if (inj) return { data: null, error: inj, count: null }
      const all = rowsOf(table)
      const match = () => all.filter(r => preds.every(p => p(r)))

      if (op === 'insert' || op === 'upsert') {
        const list: Row[] = (Array.isArray(payload) ? payload : [payload]).map(clone)
        const inserted: Row[] = []
        for (const row of list) {
          if (op === 'upsert' && onConflict) {
            const keys = onConflict.split(',').map(s => s.trim())
            const hit = all.find(e => keys.every(k => e[k] === row[k]))
            if (hit) { Object.assign(hit, row); inserted.push(hit); continue }
          }
          if (options.unique?.(table, row, all)) return { data: null, error: { message: 'duplicate key value', code: '23505' }, count: null }
          if (row.id === undefined) row.id = `${table}-${++idSeq}`
          if (row.created_at === undefined) row.created_at = new Date().toISOString()
          all.push(row); inserted.push(row)
        }
        return finish(returning ? inserted.map(clone) : null)
      }
      if (op === 'update') {
        const hit = match()
        for (const r of hit) Object.assign(r, clone(payload))
        return finish(returning ? hit.map(clone) : null)
      }
      if (op === 'delete') {
        const hit = match()
        tables[table] = all.filter(r => !hit.includes(r))
        return finish(returning ? hit.map(clone) : null, hit.length)
      }
      // select
      let out = match()
      for (const o of [...order].reverse()) out = [...out].sort((x, y) => (o.asc ? 1 : -1) * cmp(getPath(x, o.col), getPath(y, o.col)))
      const total = out.length
      if (rng) out = out.slice(rng[0], rng[1] + 1)
      if (lim != null) out = out.slice(0, lim)
      return finish(head ? null : out.map(clone), total)
    }

    function finish(data: Row[] | null, count?: number) {
      if (mode === 'many' || data === null) return { data, error: null, count: wantCount ? (count ?? data?.length ?? 0) : null }
      const first = data[0] ?? null
      if (mode === 'single' && !first) return { data: null, error: { message: 'no rows', code: 'PGRST116' }, count: null }
      return { data: first, error: null, count: null }
    }
    return b
  }

  const client = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args })
      const h = options.rpc?.[name]
      if (!h) return { data: null, error: { message: `no such function ${name}` } }
      const r = h(args)
      return { data: r.data ?? null, error: r.error ?? null }
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => { removed.push({ bucket, paths }); return { data: null, error: null } },
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${bucket}/${p}` } }),
        upload: async () => ({ data: {}, error: null }),
      }),
    },
  }
  return { client, tables, calls, removed, rpcCalls }
}
