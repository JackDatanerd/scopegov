import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  session: null as any,
  clients: [] as any[],
  rpcResult: { data: null as any, error: null as any },
  rpcCalls: [] as any[],
  audits: [] as any[],
}))

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => h.session,
  hasPermission: (s: any, p: string) => (s?.permissions || []).includes(p),
}))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const b: any = new Proxy({}, {
        get: (_t, prop: string) => prop === 'then'
          ? (res: any) => res({ data: h.clients, error: null })
          : () => b,
      })
      return b
    },
    rpc: async (name: string, args: any) => { h.rpcCalls.push({ name, args }); return h.rpcResult },
  }),
}))

import { POST } from '@/app/api/clients/[id]/merge/route'

const ALL = ['CREATE_PROJECTS', 'VIEW_CLIENT_DATA', 'DELETE_PROJECTS', 'VIEW_ALL_PROJECTS']
const req = (body: any) => ({ json: async () => body, headers: new Headers() }) as any
const call = (body: any) => POST(req(body), { params: Promise.resolve({ id: '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c' }) })

beforeEach(() => {
  h.session = { id: 'u1', email: 'a@b.co', name: 'A', workspaceId: 'w1', permissions: ALL }
  h.clients = [{ id: '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c', name: 'Acme Ltd', email: 'old@acme.test' }, { id: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a', name: 'Acme', email: 'new@acme.test' }]
  h.rpcResult = { data: { projects_moved: 2, contacts_moved: 1, contacts_dropped: 0, cc_dropped: 0, fields_carried: ['billing_address', 'notes'], notes_truncated: false }, error: null }
  h.rpcCalls.length = 0; h.audits.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/clients/[id]/merge', () => {
  it('needs VIEW_ALL_PROJECTS as well — a limited-access member cannot move projects they cannot see', async () => {
    h.session.permissions = ALL.filter(p => p !== 'VIEW_ALL_PROJECTS')
    const res = await call({ targetId: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a' })
    expect(res.status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('still needs each of the original three permissions', async () => {
    for (const missing of ['CREATE_PROJECTS', 'VIEW_CLIENT_DATA', 'DELETE_PROJECTS']) {
      h.session.permissions = ALL.filter(p => p !== missing)
      expect((await call({ targetId: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a' })).status).toBe(403)
    }
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('merges, returns the RPC result, and records the carried-over fields in the audit row', async () => {
    const res = await call({ targetId: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, targetId: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a', projects_moved: 2, fields_carried: ['billing_address', 'notes'] })
    expect(h.rpcCalls[0]).toMatchObject({ name: 'merge_clients', args: { p_workspace_id: 'w1', p_source: '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c', p_target: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a' } })
    expect(h.audits[0]).toMatchObject({
      eventType: 'client.merged', entityId: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
      metadata: { fields: ['billing_address', 'notes'], notes_truncated: false, projects_moved: 2 },
    })
  })

  it('refuses to merge a client into itself and 404s a client outside the workspace', async () => {
    expect((await call({ targetId: '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c' })).status).toBe(400)
    h.clients = [{ id: '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c', name: 'Acme Ltd', email: 'old@acme.test' }]
    expect((await call({ targetId: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a' })).status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
  })
})
