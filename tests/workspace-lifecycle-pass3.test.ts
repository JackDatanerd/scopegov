import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Workspace lifecycle independent pass 3:
//  1. account/delete reports owner_must_transfer with real guidance (was the generic fallback)
//  2. workspace/create writes workspace.created through logAudit (so ip_address is filled)
//  3. workspace/profile skips the write + audit entry when the name is unchanged
//  4. workspace/profile writes user.name_changed to every workspace the person is active in

const logAudit = vi.fn(async () => true)
const logSecurityAudit = vi.fn(async () => {})
vi.mock('@/lib/utils/audit', () => ({ logAudit }))
vi.mock('@/lib/auth/security-audit', () => ({ logSecurityAudit }))

function builder(result: any, onCall?: (name: string, args: any[]) => void) {
  const b: any = new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') return (res: any, rej: any) => Promise.resolve(result).then(res, rej)
      return (...a: any[]) => { onCall?.(prop, a); return b }
    },
  })
  return b
}

let tables: Record<string, any> = {}
let updates: Array<{ table: string; args: any[] }> = []
let rpcImpl: (fn: string, args: any) => any = () => ({ error: null })
let session: any = null

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (t: string) => builder(tables[t] ?? { data: null, error: null }, (n, a) => { if (n === 'update') updates.push({ table: t, args: a }) }),
    rpc: async (fn: string, args: any) => rpcImpl(fn, args),
    auth: { admin: { updateUserById: async () => ({ error: null }) } },
  }),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.co', user_metadata: { name: 'Meta' } } } }),
      signOut: async () => ({}),
    },
  }),
}))
vi.mock('@/lib/auth/session', () => ({ getSession: async () => session }))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUp: async () => null, requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/utils/account-erasure', () => ({ banAuthUser: async () => ({ ok: true }) }))
vi.mock('@/lib/email/templates', async () => {
  const actual: any = await vi.importActual('@/lib/email/templates')
  return Object.fromEntries(Object.keys(actual).map(k => [k, async () => ({})]))
})

const jsonReq = (url: string, method: string, body: any) =>
  new NextRequest(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  tables = { users: { data: { deleted_at: null, name: 'Old Name' }, error: null } }
  updates = []
  rpcImpl = () => ({ error: null })
  session = { id: 'u1', email: 'a@b.co', name: 'Old Name', workspaceId: 'w1' }
  logAudit.mockClear(); logSecurityAudit.mockClear()
})

describe('DELETE /api/account/delete — owner_must_transfer', () => {
  it('tells a workspace creator to transfer ownership instead of the generic message', async () => {
    tables.users = { data: { name: 'Old Name', deleted_at: null }, error: null }
    tables.workspace_members = { data: [{ id: 'm1', workspace_id: 'w1', workspaces: { name: 'Acme' } }], error: null }
    rpcImpl = () => ({ error: { message: 'owner_must_transfer' } })
    const { DELETE } = await import('@/app/api/account/delete/route')
    const res = await DELETE(jsonReq('http://localhost/api/account/delete', 'DELETE', { confirmEmail: 'a@b.co' }))
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).toContain('"Acme"')
    expect(json.error).toMatch(/transfer ownership/i)
    expect(json.error).not.toMatch(/could not leave this workspace/)
  })
})

describe('POST /api/workspace/create — audit goes through logAudit', () => {
  it('logs workspace.created via logAudit (which stamps the request IP)', async () => {
    tables.users = { data: { deleted_at: null, name: 'Jane' }, error: null }
    const { POST } = await import('@/app/api/workspace/create/route')
    const res = await POST(jsonReq('http://localhost/api/workspace/create', 'POST', { agencyName: 'Acme', industry: 'Other' }))
    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledTimes(1)
    const p: any = (logAudit.mock.calls[0] as any[])[1]
    expect(p.eventType).toBe('workspace.created')
    expect(p.actorName).toBe('Jane')
    expect(p.entityName).toBe('Acme')
  })
})

describe('PATCH /api/workspace/profile', () => {
  it('does not write users or audit when the name is unchanged', async () => {
    const { PATCH } = await import('@/app/api/workspace/profile/route')
    const res = await PATCH(jsonReq('http://localhost/api/workspace/profile', 'PATCH', { name: '  Old Name ' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.unchanged).toBe(true)
    expect(updates.filter(u => u.table === 'users')).toHaveLength(0)
    expect(logSecurityAudit).not.toHaveBeenCalled()
  })

  it('writes the new name and one account-wide audit entry carrying the stored previous name', async () => {
    const { PATCH } = await import('@/app/api/workspace/profile/route')
    const res = await PATCH(jsonReq('http://localhost/api/workspace/profile', 'PATCH', { name: 'New Name' }))
    expect(res.status).toBe(200)
    expect(updates.filter(u => u.table === 'users')).toHaveLength(1)
    expect(logSecurityAudit).toHaveBeenCalledTimes(1)
    const p: any = (logSecurityAudit.mock.calls[0] as any[])[1]
    expect(p.eventType).toBe('user.name_changed')
    expect(p.metadata).toEqual({ previousName: 'Old Name' })
    expect(p.allWorkspaces).not.toBe(false)
    expect(p.fallbackWorkspaceId).toBe('w1')
  })

  it('compares against the stored name, not a session fallback (empty stored name counts as changed)', async () => {
    tables.users = { data: { name: '' }, error: null }
    session.name = 'Meta'
    const { PATCH } = await import('@/app/api/workspace/profile/route')
    const res = await PATCH(jsonReq('http://localhost/api/workspace/profile', 'PATCH', { name: 'Meta' }))
    expect(res.status).toBe(200)
    expect(updates.filter(u => u.table === 'users')).toHaveLength(1)
  })
})
