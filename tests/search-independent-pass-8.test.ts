import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scopeToMemberProjects, MEMBER_PROJECT_EMBED, MEMBER_PROJECT_EMBED_SUFFIX } from '@/lib/utils/member-project-scope'

// Search round 8: a project-restricted member's whole project list used to be sent back in `.in('project_id', ids)`
// on every query (URL-length failure for long-tenured members). The restriction is now an embedded filter.

function recorder() {
  const calls: any[][] = []
  const q: any = new Proxy({}, { get: (_t, prop: string) => (...args: any[]) => { calls.push([prop, ...args]); return q } })
  return { q, calls }
}

describe('scopeToMemberProjects', () => {
  it('filters on the member and on an ACTIVE membership through the given path', () => {
    const { q, calls } = recorder()
    scopeToMemberProjects(q, 'u1', 'projects.project_members')
    expect(calls).toEqual([
      ['eq', 'projects.project_members.workspace_members.user_id', 'u1'],
      ['eq', 'projects.project_members.workspace_members.status', 'active'],
    ])
  })
  it('works from a projects query (path "project_members")', () => {
    const { q, calls } = recorder()
    scopeToMemberProjects(q, 'u1', 'project_members')
    expect(calls[0]).toEqual(['eq', 'project_members.workspace_members.user_id', 'u1'])
  })
  it('the embed is inner-joined at both levels and selects the filtered columns', () => {
    expect(MEMBER_PROJECT_EMBED).toBe('project_members!inner(workspace_members!inner(user_id, status))')
    expect(MEMBER_PROJECT_EMBED_SUFFIX).toBe(`, ${MEMBER_PROJECT_EMBED}`)
  })
})

describe('no caller sends a member\'s project id list in the URL any more', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  const files = [
    'app/api/search/route.ts',
    'app/(app)/sow/page.tsx',
    'app/(app)/invoices/page.tsx',
    'app/api/invoices/export/route.ts',
    'app/api/invoices/route.ts',
  ]
  for (const f of files) {
    it(`${f} filters through the relationship`, () => {
      const src = read(f)
      expect(src).not.toMatch(/\.in\('project_id',\s*(allowedProjectIds|restrictedProjectIds|\(ids)/)
      expect(src).not.toMatch(/allowedProjectIds|restrictedProjectIds/)
      expect(src).toContain('scopeToMemberProjects')
      expect(src).toContain('MEMBER_PROJECT_EMBED_SUFFIX')
    })
  }
})

// Behavioural check on the route: a restricted member with a huge membership list sends constant-size requests.
type TableResult = { data: any[] | null; error: { message: string } | null; count?: number }
let tables: Record<string, TableResult> = {}
let session: any
let queried: Array<{ table: string; calls: any[][] }> = []
function builder(table: string) {
  const rec = { table, calls: [] as any[][] }
  queried.push(rec)
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') { const res = tables[table] || { data: [], error: null }; return (resolve: any) => resolve(res) }
      return (...args: any[]) => { rec.calls.push([prop, ...args]); return chain }
    },
  })
  return chain
}
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => builder(t) }) }))
vi.mock('@/lib/auth/session', () => ({ getSession: async () => session, hasPermission: (s: any, p: string) => !!s?.perms?.includes(p) }))
import { GET } from '@/app/api/search/route'

describe('GET /api/search for a restricted member on many projects', () => {
  beforeEach(() => {
    tables = {}; queried = []
    session = { id: 'u-many', workspaceId: 'w1', perms: ['VIEW_CLIENT_DATA', 'VIEW_FINANCIALS'] }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  it('reads membership as a head count (not an id list) and puts no `in` list on any project-scoped query', async () => {
    tables.project_members = { data: null, count: 900, error: null }
    await GET({ url: 'http://x.test/api/search?q=acme' } as any)
    const pm = queried.find(q => q.table === 'project_members')!
    expect(pm.calls.find(c => c[0] === 'select')![2]).toMatchObject({ count: 'exact', head: true })
    for (const t of ['projects', 'change_orders', 'sow_documents', 'invoices', 'guardian_flags']) {
      for (const q of queried.filter(x => x.table === t)) {
        expect(q.calls.some(c => c[0] === 'in' && (c[1] === 'project_id' || c[1] === 'id'))).toBe(false)
        const path = t === 'projects' ? 'project_members' : 'projects.project_members'
        expect(q.calls).toContainEqual(['eq', `${path}.workspace_members.user_id`, 'u-many'])
      }
    }
  })
  it('a failed membership lookup is an outage, not "no projects"', async () => {
    tables.project_members = { data: null, error: { message: 'down' } }
    const res = await GET({ url: 'http://x.test/api/search?q=acme' } as any)
    expect(res.status).toBe(500)
  })
  it('a full-access member gets no membership embed or lookup at all', async () => {
    session.perms = ['VIEW_ALL_PROJECTS', 'VIEW_CLIENT_DATA', 'VIEW_FINANCIALS']
    await GET({ url: 'http://x.test/api/search?q=acme' } as any)
    expect(queried.some(q => q.table === 'project_members')).toBe(false)
    const co = queried.find(q => q.table === 'change_orders')!
    expect(co.calls.find(c => c[0] === 'select')![1]).not.toContain('project_members')
  })
})
