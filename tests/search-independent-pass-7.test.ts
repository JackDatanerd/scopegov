import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

type TableResult = { data: any[] | null; error: { message: string } | null }
let tables: Record<string, TableResult> = {}
let session: any
let queried: Array<{ table: string; calls: any[][] }> = []

function builder(table: string) {
  const rec = { table, calls: [] as any[][] }
  queried.push(rec)
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        const res = tables[table] || { data: [], error: null }
        return (resolve: any) => resolve(res)
      }
      return (...args: any[]) => { rec.calls.push([prop, ...args]); return chain }
    },
  })
  return chain
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => builder(t) }) }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => session,
  hasPermission: (s: any, p: string) => !!s?.perms?.includes(p),
}))

import { GET } from '@/app/api/search/route'
import { truncateByCodePoint } from '@/lib/search/query'

const req = (q: string) => ({ url: `http://x.test/api/search?q=${encodeURIComponent(q)}` }) as any
const ALL = ['VIEW_ALL_PROJECTS', 'VIEW_CLIENT_DATA', 'VIEW_FINANCIALS']
const calls = (table: string) => queried.filter(q => q.table === table).flatMap(q => q.calls)

beforeEach(() => {
  tables = {}; queried = []
  session = { id: 'u-' + Math.random(), workspaceId: 'w1', perms: ALL }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Search round 7 — accent-folded CO / invoice / flag text matching', () => {
  it.each(['change_orders', 'invoices'])('%s match their title on the folded search_text column, not the raw title', async (table) => {
    await GET(req('Café extras'))
    const c = calls(table)
    expect(c.some(x => x[0] === 'ilike' && x[1] === 'search_text' && x[2] === '%cafe%')).toBe(true)
    expect(c.some(x => x[0] === 'ilike' && x[1] === 'search_text' && x[2] === '%extras%')).toBe(true)
    // the whole-phrase prefix and equality fetches are folded too
    expect(c.some(x => x[0] === 'ilike' && x[1] === 'search_text' && x[2] === 'cafe extras%')).toBe(true)
    expect(c.some(x => x[0] === 'ilike' && x[1] === 'search_text' && x[2] === 'cafe extras')).toBe(true)
    expect(c.some(x => x[0] === 'ilike' && x[1] === 'title')).toBe(false)
  })

  it('flags match description + SOW clause on search_text; no raw description / sow_reference ilike remains', async () => {
    await GET(req('Café §2'))
    const c = calls('guardian_flags')
    expect(c.some(x => x[0] === 'ilike' && x[1] === 'search_text' && x[2] === '%cafe%')).toBe(true)
    expect(c.some(x => x[0] === 'ilike' && x[1] === 'search_text' && x[2] === '%§2%')).toBe(true)
    expect(c.some(x => x[0] === 'ilike' && (x[1] === 'description' || x[1] === 'sow_reference'))).toBe(false)
  })

  it('still returns and links a flag/CO/invoice row found this way', async () => {
    tables.guardian_flags = { data: [{ id: 'f1', description: 'Café menu redesign requested', severity: 'high', status: 'open', project_id: 'p1', projects: { name: 'Acme' } }], error: null }
    tables.change_orders = { data: [{ id: 'c1', title: 'Café extras', document_number: null, status: 'draft', project_id: 'p1', projects: { name: 'Acme' } }], error: null }
    tables.invoices = { data: [{ id: 'i1', title: 'Café deposit', invoice_number: null, status: 'draft', project_id: 'p1', projects: { name: 'Acme' } }], error: null }
    const json = await (await GET(req('cafe'))).json()
    const types = json.results.map((r: any) => r.type)
    expect(types).toEqual(expect.arrayContaining(['guardian_flag', 'change_order', 'invoice']))
  })

  it('migration 137 adds folded search_text + trigram index to all three tables, idempotently', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '137_doc_title_search_text.sql'), 'utf8')
    for (const t of ['change_orders', 'invoices', 'guardian_flags']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t} ADD COLUMN IF NOT EXISTS search_text`))
      expect(sql).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${t}_search_text_trgm`))
    }
    expect(sql).toMatch(/immutable_unaccent/)
  })
})

describe('Search round 7 — flag titles are cut by code point', () => {
  it('never leaves a lone surrogate when the cut lands inside an emoji', () => {
    const s = 'x'.repeat(79) + '😀' + 'tail'
    const out = truncateByCodePoint(s, 80)
    expect(out).toBe('x'.repeat(79) + '😀…')
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false)
  })
  it('leaves short text alone and cuts long text at exactly max code points', () => {
    expect(truncateByCodePoint('short', 80)).toBe('short')
    expect(truncateByCodePoint('😀'.repeat(80), 80)).toBe('😀'.repeat(80))
    expect(Array.from(truncateByCodePoint('😀'.repeat(90), 80)).length).toBe(81)
  })
  it('the route uses it for the flag title', async () => {
    tables.guardian_flags = { data: [{ id: 'f1', description: 'x'.repeat(79) + '😀tail', severity: 'low', status: 'open', project_id: 'p1', projects: { name: 'Acme' } }], error: null }
    const json = await (await GET(req('xxx'))).json()
    const t: string = json.results.find((r: any) => r.type === 'guardian_flag').title
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(t)).toBe(false)
  })
})
