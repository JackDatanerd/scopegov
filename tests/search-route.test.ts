import { describe, it, expect, beforeEach, vi } from 'vitest'

type TableResult = { data: any[] | null; error: { message: string } | null }
let tables: Record<string, TableResult> = {}
let session: any
let queried: Array<{ table: string; calls: any[][] }> = []

// A chainable, thenable stand-in for a PostgREST query builder.
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
const usedTables = () => queried.map(q => q.table)

beforeEach(() => {
  tables = {}; queried = []
  session = { id: 'u-' + Math.random(), workspaceId: 'w1', perms: ALL }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/search', () => {
  it('requires a session', async () => {
    session = null
    expect((await GET(req('acme'))).status).toBe(401)
  })

  it('returns nothing (and queries nothing) for a query under 2 characters', async () => {
    const res = await GET(req('a'))
    expect(await res.json()).toEqual({ results: [] })
    expect(queried).toHaveLength(0)
  })

  it('a failing block is reported as partial instead of silently looking like "no matches"', async () => {
    tables.projects = { data: [{ id: 'p1', name: 'Acme Site', disc: null, status: 'Active', clients: { name: 'Acme' } }], error: null }
    tables.sow_documents = { data: null, error: { message: 'boom' } }
    const res = await GET(req('acme'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.partial).toBe(true)
    expect(json.results.map((r: any) => r.type)).toContain('project')
  })

  it('every block failing is an outage (500), not an empty result set', async () => {
    for (const t of ['clients', 'projects', 'client_contacts', 'change_orders', 'sow_documents', 'invoices', 'guardian_flags'])
      tables[t] = { data: null, error: { message: 'db down' } }
    const res = await GET(req('acme'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/unavailable/i)
  })

  it('finds a SOW through its project, using an INNER embed so the limit applies to matches', async () => {
    tables.sow_documents = { data: [{ id: 's1', document_number: 'SOW-0010', status: 'awaiting_signature', version: 1, project_id: 'p9', projects: { name: 'Acme Rebrand' } }], error: null }
    const json = await (await GET(req('rebrand'))).json()
    expect(json.results.find((r: any) => r.type === 'sow')).toMatchObject({ id: 's1', href: '/projects/p9?tab=sow' })
    const sow = queried.find(q => q.table === 'sow_documents')!
    const select = sow.calls.find(c => c[0] === 'select')![1] as string
    expect(select).toContain('projects!inner(')
    expect(sow.calls).toContainEqual(['is', 'projects.deleted_at', null])
  })

  it('does not query contacts without VIEW_CLIENT_DATA, nor invoices without VIEW_FINANCIALS', async () => {
    session.perms = ['VIEW_ALL_PROJECTS']
    await GET(req('acme'))
    expect(usedTables()).not.toContain('client_contacts')
    expect(usedTables()).not.toContain('invoices')
    expect(usedTables()).toContain('projects')
  })

  it('a member limited to their own projects with none assigned sees no project-scoped results and triggers no such queries', async () => {
    session.perms = ['VIEW_CLIENT_DATA', 'VIEW_FINANCIALS'] // no VIEW_ALL_PROJECTS
    tables.project_members = { data: [], error: null }
    const json = await (await GET(req('acme'))).json()
    const t = usedTables()
    for (const scoped of ['projects', 'change_orders', 'sow_documents', 'invoices', 'guardian_flags']) expect(t).not.toContain(scoped)
    expect(json.results.every((r: any) => ['client', 'contact'].includes(r.type))).toBe(true)
  })

  it('restricts project-scoped blocks to the member\'s own project ids', async () => {
    session.perms = ['VIEW_CLIENT_DATA']
    tables.project_members = { data: [{ project_id: 'mine' }], error: null }
    await GET(req('acme'))
    const co = queried.find(q => q.table === 'change_orders')!
    expect(co.calls).toContainEqual(['in', 'project_id', ['mine']])
  })

  it('ranks an exact/starts-with project ahead of a mere substring match', async () => {
    tables.projects = { data: [
      { id: 'p-sub',   name: 'Remarketing Plan', disc: null, status: 'Active', clients: { name: 'X' } },
      { id: 'p-exact', name: 'Marketing',        disc: null, status: 'Active', clients: { name: 'X' } },
    ], error: null }
    const json = await (await GET(req('marketing'))).json()
    const projects = json.results.filter((r: any) => r.type === 'project').map((r: any) => r.id)
    expect(projects).toEqual(['p-exact', 'p-sub'])
  })

  it('folds accents in the query it sends for the indexed columns ("Café" → "cafe")', async () => {
    await GET(req('Café'))
    const clients = queried.find(q => q.table === 'clients')!
    expect(clients.calls).toContainEqual(['ilike', 'search_text', '%cafe%'])
  })

  it('escapes LIKE wildcards so "100%" does not match everything', async () => {
    await GET(req('100%'))
    const clients = queried.find(q => q.table === 'clients')!
    expect(clients.calls).toContainEqual(['ilike', 'search_text', '%100\\%%'])
  })

  it('a contact whose client is already listed is not repeated', async () => {
    tables.clients = { data: [{ id: 'c1', name: 'Acme', company_name: 'Acme Corp', email: 'a@acme.test', status: 'active' }], error: null }
    tables.client_contacts = { data: [{ id: 'k1', name: 'Jane Acme', email: 'j@acme.test', role: 'Billing', client_id: 'c1', clients: { id: 'c1', name: 'Acme' } }], error: null }
    const json = await (await GET(req('acme'))).json()
    expect(json.results.filter((r: any) => r.type === 'contact')).toHaveLength(0)
    expect(json.results.filter((r: any) => r.type === 'client')).toHaveLength(1)
  })

  it('throttles a user who searches too fast', async () => {
    let last: any
    for (let i = 0; i < 125; i++) last = await GET(req('acme'))
    expect(last.status).toBe(429)
  })
})
