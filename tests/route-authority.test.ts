import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Route-level wiring for the authority rules: owner protection, workspace deletion, admin MFA reset,
// invite resend, the recovery-only password endpoint, and the default-role ceiling.

// ── chainable fake for the supabase query builder (one canned result per table) ──
function builder(result: any) {
  const b: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: any) => Promise.resolve(result).then(res)
      return (..._a: any[]) => b
    },
  })
  return b
}
const rpcCalls: Array<{ name: string; args: any }> = []
const writes: string[] = []
let tables: Record<string, any> = {}
let session: any
let jwtPayload: any = {}
let stepUpResponse: Response | null = null
let updateUserCalls = 0

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return {
    ...actual,
    getSession: async () => session,
    resolveActorName: async (_s: any, _u: any, f: string) => f,
    resolveActiveWorkspaceId: async () => 'w1',
    userHasAnyMfaMandatoryMembership: async () => false,
  }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (t: string) => {
      const b: any = builder(tables[t] ?? { data: null, error: null })
      return new Proxy(b, { get(target, prop: string) {
        if (['update', 'delete', 'insert', 'upsert'].includes(prop)) writes.push(`${t}.${prop}`)
        return target[prop]
      } })
    },
    rpc: async (name: string, args: any) => { rpcCalls.push({ name, args }); return { data: null, error: null } },
    auth: { admin: { mfa: {
      listFactors: async () => { writes.push('auth.listFactors'); return { data: { factors: [{ id: 'f1', factor_type: 'totp' }] }, error: null } },
      deleteFactor: async () => { writes.push('auth.deleteFactor'); return { error: null } },
    } } },
  }),
  createStatelessAuthClient: () => ({}),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.c', identities: [{ provider: 'email' }], user_metadata: {}, factors: [] } } }),
      getSession: async () => ({ data: { session: { access_token: 'h.' + Buffer.from(JSON.stringify(jwtPayload)).toString('base64url') + '.s' } } }),
      updateUser: async () => { updateUserCalls++; return { error: null } },
      signOut: async () => ({ error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } }) },
    },
  }),
}))
vi.mock('@/lib/auth/step-up', async () => {
  const actual: any = await vi.importActual('@/lib/auth/step-up')
  return { ...actual, requireStepUpForCurrentUser: async () => stepUpResponse, requireStepUp: async () => stepUpResponse }
})
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/email/templates', async () => {
  const actual: any = await vi.importActual('@/lib/email/templates')
  return Object.fromEntries(Object.keys(actual).map(k => [k, async () => ({})]))
})
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async () => true }))
vi.mock('@/lib/utils/notify', async () => {
  const actual: any = await vi.importActual('@/lib/utils/notify')
  return Object.fromEntries(Object.keys(actual).map(k => [k, async () => undefined]))
})
vi.mock('@/lib/utils/rate-limit', () => ({ checkInviteRateLimit: async () => ({ allowed: true }) }))
vi.mock('@/lib/utils/seat-limit', () => ({ checkSeatLimit: async () => ({ ok: true }) }))

const mkSession = (permissions: string[], extra: any = {}) => ({
  id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x', agencyName: 'A', workspaceName: 'Acme', planTier: 'agency', permissions, ...extra,
})
const json = (url: string, method: string, body?: any) =>
  new NextRequest('http://localhost' + url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const P = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  rpcCalls.length = 0; writes.length = 0; tables = {}; stepUpResponse = null; updateUserCalls = 0
  jwtPayload = {}
  session = mkSession(['MANAGE_ROLES', 'INVITE_MEMBERS'])
})

// ─────────────────────────────────────────────────────────────────────────────
describe('/api/auth/reset-password only serves recovery-link sessions', () => {
  const nowS = () => Math.floor(Date.now() / 1000)
  async function post() {
    const { POST } = await import('../app/api/auth/reset-password/route')
    return POST(json('/api/auth/reset-password', 'POST', { password: 'a-brand-new-passphrase' }))
  }

  it('rejects a normal password sign-in (it used to be accepted for 15 minutes)', async () => {
    jwtPayload = { amr: [{ method: 'password', timestamp: nowS() - 60 }] }
    const res = await post()
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('not_recovery_session')
    expect(updateUserCalls).toBe(0)
  })

  it('accepts a fresh recovery session', async () => {
    jwtPayload = { amr: [{ method: 'recovery', timestamp: nowS() - 60 }] }
    const res = await post()
    expect(res.status).toBe(200)
    expect(updateUserCalls).toBe(1)
  })

  it('a recovery session older than 15 minutes is stale', async () => {
    jwtPayload = { amr: [{ method: 'recovery', timestamp: nowS() - 3600 }] }
    const res = await post()
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('stale_session')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('role PATCH: making a role the default respects the delegation ceiling', () => {
  it('refuses a role that holds permissions the actor does not (403, nothing changed)', async () => {
    tables.roles = { data: { name: 'Owner', description: null, permissions: { MANAGE_BILLING: true, MANAGE_ROLES: true }, is_default: false }, error: null }
    const { PATCH } = await import('../app/api/team/roles/[id]/route')
    const res = await PATCH(json('/api/team/roles/r1', 'PATCH', { isDefault: true }), P('r1'))
    expect(res.status).toBe(403)
    expect(rpcCalls.find(c => c.name === 'set_default_role_atomic')).toBeUndefined()
  })

  it('allows it for a role within the actor\u2019s own permissions', async () => {
    tables.roles = { data: { name: 'Helper', description: null, permissions: { MANAGE_ROLES: true }, is_default: false }, error: null }
    const { PATCH } = await import('../app/api/team/roles/[id]/route')
    const res = await PATCH(json('/api/team/roles/r1', 'PATCH', { isDefault: true }), P('r1'))
    expect(res.status).toBe(200)
    expect(rpcCalls.some(c => c.name === 'set_default_role_atomic')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the workspace owner cannot be removed or re-roled by anyone else', () => {
  const ownerRow = { data: { id: 'm-owner', user_id: 'owner1', role_id: 'r', status: 'active', invited_email: null, effective_permissions: { MANAGE_ROLES: true }, permission_overrides: null, users: { name: 'Olive', email: 'o@x' } }, error: null }

  it('DELETE (deactivate) is refused with the owner-protected message', async () => {
    tables.workspace_members = ownerRow
    tables.workspaces = { data: { created_by: 'owner1' }, error: null }
    const { DELETE } = await import('../app/api/team/[id]/route')
    const res = await DELETE(json('/api/team/m-owner', 'DELETE'), P('m-owner'))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/workspace owner/i)
    expect(writes).not.toContain('workspace_members.update')
  })

  it('PATCH (role / overrides) is refused too', async () => {
    tables.workspace_members = ownerRow
    tables.workspaces = { data: { created_by: 'owner1' }, error: null }
    tables.roles = { data: { id: 'r2', permissions: { MANAGE_ROLES: true } }, error: null }
    const { PATCH } = await import('../app/api/team/[id]/route')
    const res = await PATCH(json('/api/team/m-owner', 'PATCH', { permissionOverrides: { MANAGE_ROLES: false } }), P('m-owner'))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/workspace owner/i)
  })

  it('an ordinary member is not protected (the guard is specific to the owner)', async () => {
    tables.workspace_members = { data: { ...ownerRow.data, user_id: 'someone-else', effective_permissions: { MANAGE_ROLES: true } }, error: null }
    tables.workspaces = { data: { created_by: 'owner1' }, error: null }
    const { DELETE } = await import('../app/api/team/[id]/route')
    const res = await DELETE(json('/api/team/m2', 'DELETE'), P('m2'))
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE /api/workspace/delete', () => {
  beforeEach(() => { session = mkSession(['MANAGE_WORKSPACE_SETTINGS'], { id: 'settings-admin' }) })
  async function del(body?: any) {
    const { DELETE } = await import('../app/api/workspace/delete/route')
    return DELETE(json('/api/workspace/delete', 'DELETE', body))
  }

  it('a settings admin cannot delete a workspace whose owner is still an active member', async () => {
    tables.workspaces = { data: { created_by: 'owner1' }, error: null }
    tables.workspace_members = { data: { id: 'owner-member' }, error: null }
    const res = await del({ confirmName: 'Acme' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/only the workspace owner/i)
  })

  it('but can when the owner is no longer an active member (otherwise nobody could)', async () => {
    tables.workspaces = { data: { created_by: 'owner1' }, error: null }
    tables.workspace_members = { data: null, error: null }
    stepUpResponse = new Response(JSON.stringify({ code: 'step_up_required', methods: ['password'] }), { status: 401 })
    const res = await del({ confirmName: 'Acme' })
    expect(res.status).toBe(401)              // got past the ownership rule, stopped at the step-up
  })

  it('requires the workspace name typed server-side', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'], { id: 'owner1' })
    tables.workspaces = { data: { created_by: 'owner1' }, error: null }
    expect((await del({ confirmName: 'wrong' })).status).toBe(400)
    expect((await del()).status).toBe(400)
  })

  it('requires a step-up before anything is deleted', async () => {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'], { id: 'owner1' })
    tables.workspaces = { data: { created_by: 'owner1' }, error: null }
    stepUpResponse = new Response(JSON.stringify({ code: 'step_up_required', methods: ['totp'] }), { status: 401 })
    const res = await del({ confirmName: 'Acme' })
    expect(res.status).toBe(401)
    expect(writes).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('admin MFA reset', () => {
  it('needs the ACTOR to step up first — no factor is touched without it', async () => {
    stepUpResponse = new Response(JSON.stringify({ code: 'step_up_required', methods: ['totp'] }), { status: 401 })
    const { POST } = await import('../app/api/team/[id]/reset-mfa/route')
    const res = await POST(json('/api/team/m1/reset-mfa', 'POST'), P('m1'))
    expect(res.status).toBe(401)
    expect(writes).toEqual([])
  })

  it('revokes the target\u2019s sessions once it proceeds', async () => {
    tables.workspace_members = { data: { id: 'm1', user_id: 'target', status: 'active', effective_permissions: { INVITE_MEMBERS: true }, users: { name: 'T', email: 't@x' } }, error: null }
    const { POST } = await import('../app/api/team/[id]/reset-mfa/route')
    const res = await POST(json('/api/team/m1/reset-mfa', 'POST'), P('m1'))
    expect(res.status).toBe(200)
    expect(writes).toContain('auth.deleteFactor')
    expect(rpcCalls).toContainEqual({ name: 'revoke_user_sessions', args: { p_user: 'target', p_except: null } })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('invite resend', () => {
  it('cannot resend an invite for a role above the resender\u2019s own permissions', async () => {
    tables.workspace_members = { data: { id: 'i1', status: 'invited', invited_email: 'x@y.z', user_id: null, invited_by: 'other', invite_token: 't', invite_token_expires_at: null,
      roles: { name: 'Admin', permissions: { MANAGE_BILLING: true } }, users: null }, error: null }
    const { POST } = await import('../app/api/team/[id]/resend/route')
    const res = await POST(json('/api/team/i1/resend', 'POST'), P('i1'))
    expect(res.status).toBe(403)
    expect(writes).not.toContain('workspace_members.update')
  })
})
