import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const req = (q: string) => ({ url: `http://x.test/api/search?q=${encodeURIComponent(q)}` }) as any
const ALL = ['VIEW_ALL_PROJECTS', 'VIEW_CLIENT_DATA', 'VIEW_FINANCIALS']
const callsOf = (table: string) => queried.filter(q => q.table === table)
const has = (table: string, pred: (c: any[]) => boolean) => callsOf(table).some(q => q.calls.some(pred))

beforeEach(() => {
  tables = {}; queried = []
  session = { id: 'u-' + Math.random(), workspaceId: 'w1', perms: ALL }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Search round 5 — exact-name fetches and ordered prefix fetches', () => {
  it('runs a whole-name equality fetch for clients, projects, change orders and invoices', async () => {
    await GET(req('Acme Labs'))
    expect(has('clients', c => c[0] === 'ilike' && c[1] === 'name' && c[2] === 'acme labs')).toBe(true)
    expect(has('projects', c => c[0] === 'ilike' && c[1] === 'name' && c[2] === 'acme labs')).toBe(true)
    expect(has('change_orders', c => c[0] === 'ilike' && c[1] === 'search_text' && c[2] === 'acme labs')).toBe(true)
    expect(has('invoices', c => c[0] === 'ilike' && c[1] === 'search_text' && c[2] === 'acme labs')).toBe(true)
  })

  it('escapes LIKE wildcards in the equality fetch', async () => {
    await GET(req('100%_x'))
    expect(has('clients', c => c[0] === 'ilike' && c[1] === 'name' && c[2] === '100\\%\\_x')).toBe(true)
  })

  it('no start-of-text or number fetch is left without an ORDER BY', async () => {
    await GET(req('Acme Site'))
    const unordered = queried.filter(q =>
      q.calls.some(c => c[0] === 'ilike' && typeof c[2] === 'string' && c[2].endsWith('%') && !c[2].startsWith('%')) &&
      !q.calls.some(c => c[0] === 'order'))
    expect(unordered).toEqual([])
  })

  it('a duplicate-prefix workspace still returns the row whose name is the query', async () => {
    tables.clients = { data: [
      { id: 'c2', name: 'Acme Labs', company_name: null, email: null, status: 'active' },
      { id: 'c1', name: 'Acme', company_name: null, email: null, status: 'active' },
    ], error: null }
    const json = await (await GET(req('acme'))).json()
    expect(json.results.filter((r: any) => r.type === 'client')[0].id).toBe('c1')
  })
})

describe('Search round 5 — contacts of an already-listed client cannot take the slots', () => {
  it('excludes listed clients in the contacts query itself, ahead of the row limit', async () => {
    tables.clients = { data: [{ id: 'c1', name: 'Samson Ltd', company_name: null, email: null, status: 'active' }], error: null }
    await GET(req('sam'))
    expect(has('client_contacts', c => c[0] === 'not' && c[1] === 'client_id' && c[2] === 'in' && String(c[3]).includes('c1'))).toBe(true)
  })

  it('does not add the exclusion when no client matched', async () => {
    await GET(req('sam'))
    expect(has('client_contacts', c => c[0] === 'not')).toBe(false)
  })

  it('three contacts of the listed client do not displace a contact at another client', async () => {
    tables.clients = { data: [{ id: 'c1', name: 'Samson Ltd', company_name: null, email: null, status: 'active' }], error: null }
    tables.client_contacts = { data: [
      { id: 'k1', name: 'Sam One', email: 's1@samson.test', role: null, client_id: 'c1', clients: { id: 'c1', name: 'Samson Ltd' } },
      { id: 'k2', name: 'Sam Two', email: 's2@samson.test', role: null, client_id: 'c1', clients: { id: 'c1', name: 'Samson Ltd' } },
      { id: 'k3', name: 'Sam Three', email: 's3@samson.test', role: null, client_id: 'c1', clients: { id: 'c1', name: 'Samson Ltd' } },
      { id: 'k4', name: 'Samira Khan', email: 'sk@other.test', role: null, client_id: 'c2', clients: { id: 'c2', name: 'Other Co' } },
    ], error: null }
    const json = await (await GET(req('sam'))).json()
    expect(json.results.filter((r: any) => r.type === 'contact').map((r: any) => r.id)).toEqual(['k4'])
  })
})

describe('Search round 5 — client-side guards (source checks)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('ProjectDetail follows ?tab= and writes it back when a tab is clicked', () => {
    const src = read('components/projects/ProjectDetail.tsx')
    expect(src).toMatch(/useSearchParams\(\)/)
    expect(src).toMatch(/searchParams\.get\('tab'\)/)
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(urlTab && TABS\.some\(t => t\.key === urlTab\)\) setTab\(urlTab\)/)
    expect(src).toMatch(/history\.replaceState/)
    expect(src).toMatch(/onClick=\{\(\) => selectTab\(t\.key\)\}/)
    expect(src).not.toMatch(/onClick=\{\(\) => setTab\(t\.key\)\}/)
  })

  it('the palette withholds the previous query\'s verdict while the next one is debounced', () => {
    const src = read('components/layout/CommandPalette.tsx')
    const i = src.indexOf("setStatus('idle')\n    debounce.current = setTimeout")
    expect(i).toBeGreaterThan(-1)
  })
})
