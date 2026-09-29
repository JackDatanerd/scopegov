import { describe, it, expect, vi, beforeEach } from 'vitest'

// FIX (independent pass, section 14 re-audit): PATCH /api/clients/[id] used to do a plain
// select-then-update for its email-duplicate check (an `ilike` pre-check, then a separate
// `.update()`) — the same TOCTOU shape migration 088 closed for client creation via an
// advisory-locked RPC, but never extended to this edit path. These tests pin the route's new
// shape: the duplicate check and the write both happen through one `update_client_checked` RPC
// call, and a conflict reported by the RPC (not a local `ilike` query) is what produces the 409.

const h = vi.hoisted(() => ({
  session: null as any,
  existing: null as any,
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
          ? (res: any) => res({ data: h.existing, error: null })
          : () => b,
      })
      return b
    },
    rpc: async (name: string, args: any) => { h.rpcCalls.push({ name, args }); return h.rpcResult },
  }),
}))

import { PATCH } from '@/app/api/clients/[id]/route'

const ALL = ['CREATE_PROJECTS', 'VIEW_CLIENT_DATA']
const req = (body: any) => ({ json: async () => body, headers: new Headers() }) as any
const call = (body: any) => PATCH(req(body), { params: Promise.resolve({ id: 'c1' }) })

beforeEach(() => {
  h.session = { id: 'u1', email: 'a@b.co', name: 'A', workspaceId: 'w1', permissions: ALL }
  h.existing = { id: 'c1', name: 'Acme', email: 'old@acme.test', cc_emails: [], workspace_id: 'w1' }
  h.rpcResult = { data: { ok: true, updated: true }, error: null }
  h.rpcCalls.length = 0; h.audits.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('PATCH /api/clients/[id] — email-change goes through update_client_checked', () => {
  it('sends the patch through the RPC, not a local select-then-update', async () => {
    const res = await call({ email: 'new@acme.test' })
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.rpcCalls[0].name).toBe('update_client_checked')
    expect(h.rpcCalls[0].args).toMatchObject({ p_client_id: 'c1', p_workspace_id: 'w1' })
    expect(h.rpcCalls[0].args.p_patch).toMatchObject({ email: 'new@acme.test', email_bounced_at: null, email_bounce_kind: null })
  })

  it('surfaces a conflict reported by the RPC as 409 with the existing client id, without any local dupe query', async () => {
    h.rpcResult = { data: { ok: false, existing_id: 'other-client' }, error: null }
    const res = await call({ email: 'taken@acme.test' })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json).toMatchObject({ existingClientId: 'other-client' })
    // Exactly one call into the database layer for the write path — the RPC itself did the check.
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('still surfaces the DB unique constraint as a friendly 409 (belt-and-braces, pre-108 schemas)', async () => {
    h.rpcResult = { data: null, error: { code: '23505', message: 'duplicate key' } }
    const res = await call({ email: 'race@acme.test' })
    expect(res.status).toBe(409)
  })

  it('a non-email update still calls the RPC (so every write, not just email changes, is atomic)', async () => {
    const res = await call({ phone: '+254 700 000000' })
    expect(res.status).toBe(200)
    expect(h.rpcCalls[0].args.p_patch).toMatchObject({ phone: '+254 700 000000' })
    expect(h.rpcCalls[0].args.p_patch.email).toBeUndefined()
  })

  it('records a real before → after audit row using the pre-update snapshot', async () => {
    await call({ email: 'new@acme.test' })
    expect(h.audits[0]).toMatchObject({
      eventType: 'client.updated', entityId: 'c1',
      metadata: { changes: { email: { from: 'old@acme.test', to: 'new@acme.test' } } },
    })
  })

  it('requires CREATE_PROJECTS', async () => {
    h.session.permissions = ['VIEW_CLIENT_DATA']
    expect((await call({ name: 'New name' })).status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('requires VIEW_CLIENT_DATA to touch contact-visibility fields', async () => {
    h.session.permissions = ['CREATE_PROJECTS']
    expect((await call({ email: 'x@y.co' })).status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('404s when the client does not exist in this workspace', async () => {
    h.existing = null
    expect((await call({ name: 'X' })).status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
  })
  it('404s (no success, no audit row) when the client vanished between the read and the RPC write', async () => {
    h.rpcResult = { data: { ok: true, updated: false }, error: null }
    const res = await call({ name: 'Renamed' })
    expect(res.status).toBe(404)
    expect(h.audits).toHaveLength(0)
  })
})
