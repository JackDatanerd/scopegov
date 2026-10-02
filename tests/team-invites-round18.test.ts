// tests/team-invites-round18.test.ts
//
// Regression tests for Team & Invites round 18:
//   B1 — read errors in the team routes / helpers were treated as "no data" (404s, skipped guards)
//   B2 — invite accept's second-factor lookup failed OPEN on an error
//   B3 — Team header printed "0 pending invites" for viewers who never load the list
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'fs'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any
let aalResult: any = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }
let authUser: any = { id: 'actor' }

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (res: any, rej: any) => {
          calls.push({ table, ops })
          return Promise.resolve(resolver(table, ops)).then(res, rej)
        }
      }
      return (...args: any[]) => chain(table, [...ops, { name: prop, args }])
    },
  })
}

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session, getSessionStrict: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t), rpc: async () => ({ data: [], error: null }) }),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => aalResult },
    },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/rate-limit', async () => {
  const actual: any = await vi.importActual('@/lib/utils/rate-limit')
  return { ...actual, checkInviteRateLimit: async () => ({ allowed: true }) }
})
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error('redirect:' + u) } }))

const read = (p: string) => readFileSync(p, 'utf8')
const DB_ERR = { message: 'connection reset' }
const hasDelete = (table: string) => calls.some(c => c.table === table && c.ops.some(o => o.name === 'delete'))

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  calls.length = 0
  resolver = () => ({ data: null, error: null })
  aalResult = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }
  authUser = { id: 'actor' }
  session = {
    id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x.com', agencyName: 'Acme',
    workspaceName: 'Acme', planTier: 'agency',
    permissions: ['INVITE_MEMBERS', 'MANAGE_ROLES'],
  }
})

describe('B1: a failed member read is a 500, not "not found"', () => {
  const failMembers = (table: string) => table === 'workspace_members' ? { data: null, error: DB_ERR } : { data: null, error: null }

  it('DELETE /api/team/[id]', async () => {
    resolver = failMembers
    const { DELETE } = await import('@/app/api/team/[id]/route')
    const res = await DELETE(new NextRequest('http://localhost/api/team/m1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'm1' }) })
    expect(res.status).toBe(500)
  })
  it('PATCH /api/team/[id] (role change path)', async () => {
    resolver = failMembers
    const { PATCH } = await import('@/app/api/team/[id]/route')
    const res = await PATCH(new NextRequest('http://localhost/api/team/m1', { method: 'PATCH', body: JSON.stringify({ roleId: 'r1' }) }), { params: Promise.resolve({ id: 'm1' }) })
    expect(res.status).toBe(500)
  })
  it('PATCH /api/team/[id] (reactivation path)', async () => {
    resolver = failMembers
    const { PATCH } = await import('@/app/api/team/[id]/route')
    const res = await PATCH(new NextRequest('http://localhost/api/team/m1', { method: 'PATCH', body: JSON.stringify({ status: 'active' }) }), { params: Promise.resolve({ id: 'm1' }) })
    expect(res.status).toBe(500)
  })
  it('resend, link and reset-mfa read the lookup error', () => {
    for (const p of ['app/api/team/[id]/resend/route.ts', 'app/api/team/[id]/link/route.ts', 'app/api/team/[id]/reset-mfa/route.ts']) {
      const src = read(p)
      expect(src, p).toMatch(/const \{ data: member, error: memberErr \}/)
      expect(src, p).toMatch(/if \(memberErr\) return NextResponse\.json\([^)]*\{ status: 500 \}\)/)
    }
  })
  it('POST /api/team/invite: account lookup error is a 500 and nothing is written', async () => {
    resolver = (table) => table === 'users' ? { data: null, error: DB_ERR } : { data: null, error: null }
    const { POST } = await import('@/app/api/team/invite/route')
    const res = await POST(new NextRequest('http://localhost/api/team/invite', { method: 'POST', body: JSON.stringify({ email: 'a@b.com' }) }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(calls.some(c => c.ops.some(o => o.name === 'insert'))).toBe(false)
  })
  it('POST /api/team/invite: explicit-role lookup error is a 500, not "Invalid role"', async () => {
    resolver = (table) => table === 'roles' ? { data: null, error: DB_ERR } : { data: null, error: null }
    const { POST } = await import('@/app/api/team/invite/route')
    const res = await POST(new NextRequest('http://localhost/api/team/invite', { method: 'POST', body: JSON.stringify({ email: 'a@b.com', roleId: 'r1' }) }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/try again/i)
  })
  it('POST /api/team/invite: default-role lookup error is a 500, not a skipped ceiling check', async () => {
    resolver = (table) => table === 'roles' ? { data: null, error: DB_ERR } : { data: null, error: null }
    const { POST } = await import('@/app/api/team/invite/route')
    const res = await POST(new NextRequest('http://localhost/api/team/invite', { method: 'POST', body: JSON.stringify({ email: 'a@b.com' }) }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(calls.some(c => c.ops.some(o => o.name === 'insert'))).toBe(false)
  })
  it('POST /api/team/invite: membership-guard read error is a 500', async () => {
    resolver = (table) => table === 'workspace_members' ? { data: null, error: DB_ERR } : { data: null, error: null }
    const { POST } = await import('@/app/api/team/invite/route')
    const res = await POST(new NextRequest('http://localhost/api/team/invite', { method: 'POST', body: JSON.stringify({ email: 'a@b.com' }) }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/try again/i)
    expect(calls.some(c => c.ops.some(o => o.name === 'insert'))).toBe(false)
  })
  it('DELETE /api/team/roles/[id]: holder read error is a 500 and the role is not deleted', async () => {
    resolver = (table, ops) => {
      if (table === 'roles') return { data: { id: 'r1', name: 'Custom', is_default: false, permissions: {} }, error: null }
      if (table === 'workspace_members') return { data: null, error: DB_ERR }
      return { data: null, error: null, count: 0 }
    }
    const { DELETE } = await import('@/app/api/team/roles/[id]/route')
    const res = await DELETE(new NextRequest('http://localhost/api/team/roles/r1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'r1' }) })
    expect(res.status).toBe(500)
    expect(hasDelete('roles')).toBe(false)
  })
  it('DELETE /api/team/roles/[id]: workflow-step read error is a 500 and the role is not deleted', async () => {
    resolver = (table) => {
      if (table === 'roles') return { data: { id: 'r1', name: 'Custom', is_default: false, permissions: {} }, error: null }
      if (table === 'workspace_members') return { data: [], error: null }
      if (table === 'approval_workflow_steps') return { data: null, error: DB_ERR, count: null }
      return { data: null, error: null, count: 0 }
    }
    const { DELETE } = await import('@/app/api/team/roles/[id]/route')
    const res = await DELETE(new NextRequest('http://localhost/api/team/roles/r1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'r1' }) })
    expect(res.status).toBe(500)
    expect(hasDelete('roles')).toBe(false)
  })
  it('PATCH /api/team/roles/[id]: owner-holds-role read error is a 500, not a skipped owner protection', async () => {
    resolver = (table, ops) => {
      if (table === 'roles') return { data: { name: 'Admin', description: '', permissions: { INVITE_MEMBERS: true }, is_default: false }, error: null }
      if (table === 'workspaces') return { data: { created_by: 'owner-1' }, error: null }
      if (table === 'workspace_members') return { data: null, error: DB_ERR }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(new NextRequest('http://localhost/api/team/roles/r1', { method: 'PATCH', body: JSON.stringify({ permissions: { INVITE_MEMBERS: false } }) }), { params: Promise.resolve({ id: 'r1' }) })
    expect(res.status).toBe(500)
  })
})

describe('B1: helpers throw on a failed read instead of answering with a permissive default', () => {
  it('workspaceOwnerId / isProtectedOwnerTarget', async () => {
    const { workspaceOwnerId, isProtectedOwnerTarget } = await import('@/lib/utils/owner-protection')
    const svc: any = { from: () => chain('workspaces') }
    resolver = () => ({ data: null, error: DB_ERR })
    await expect(workspaceOwnerId(svc, 'w1')).rejects.toThrow()
    await expect(isProtectedOwnerTarget(svc, 'w1', 'actor', 'owner-1')).rejects.toThrow()
    resolver = () => ({ data: { created_by: 'owner-1' }, error: null })
    expect(await workspaceOwnerId(svc, 'w1')).toBe('owner-1')
    resolver = () => ({ data: null, error: null })
    expect(await workspaceOwnerId(svc, 'w1')).toBeNull()
  })
  it('inviterMayStillGrant: inviter and role lookup errors throw (no spurious 410, no fail-open)', async () => {
    const { inviterMayStillGrant } = await import('@/lib/utils/invite-authority')
    const svc: any = { from: (t: string) => chain(t) }
    resolver = (table) => table === 'workspace_members' ? { data: null, error: DB_ERR } : { data: null, error: null }
    await expect(inviterMayStillGrant(svc, 'w1', 'inviter', 'r1')).rejects.toThrow()
    resolver = (table) => table === 'workspace_members'
      ? { data: { effective_permissions: { INVITE_MEMBERS: true } }, error: null }
      : { data: null, error: DB_ERR }
    await expect(inviterMayStillGrant(svc, 'w1', 'inviter', 'r1')).rejects.toThrow()
    await expect(inviterMayStillGrant(svc, 'w1', 'inviter', null)).rejects.toThrow()
  })
  it('roleGrantedAtAcceptance throws on a failed read', async () => {
    const { roleGrantedAtAcceptance } = await import('@/lib/utils/invite-authority')
    const svc: any = { from: (t: string) => chain(t) }
    resolver = () => ({ data: null, error: DB_ERR })
    await expect(roleGrantedAtAcceptance(svc, 'w1', 'r1')).rejects.toThrow()
    await expect(roleGrantedAtAcceptance(svc, 'w1', null)).rejects.toThrow()
  })
})

describe('B2: invite accept fails closed when the second-factor lookup errors', () => {
  const invited = {
    id: 'm1', status: 'invited', workspace_id: 'w1', invited_email: 'x@y.com', invited_by: 'inviter', role_id: 'r1',
    invite_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
    workspaces: { name: 'Acme', deleted_at: null, plan_tier: 'agency', trial_ends_at: null },
  }
  const wire = () => {
    authUser = { id: 'u2', email: 'x@y.com' }
    resolver = (table) => {
      if (table === 'users') return { data: { deleted_at: null }, error: null }
      if (table === 'workspace_members') return { data: invited, error: null }
      return { data: null, error: null }
    }
  }
  const call = async () => {
    const { POST } = await import('@/app/api/team/invite/[token]/accept/route')
    return POST(new NextRequest('http://localhost/api/team/invite/tok/accept', { method: 'POST' }), { params: Promise.resolve({ token: 'tok' }) })
  }

  it('503s on an AAL lookup error and attaches nothing', async () => {
    wire()
    aalResult = { data: null, error: { message: 'auth backend down' } }
    const res = await call()
    expect(res.status).toBe(503)
    expect(calls.some(c => c.table === 'workspace_members' && c.ops.some(o => o.name === 'update'))).toBe(false)
  })
  it('still demands the challenge when a live verified factor exists and the session is aal1', async () => {
    wire()
    authUser = { id: 'u2', email: 'x@y.com', factors: [{ status: 'verified' }] }
    aalResult = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null }
    const res = await call()
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('mfa_required')
  })
  it('does not demand a challenge for a stale cached aal2 once the live factor list is empty', async () => {
    wire()
    authUser = { id: 'u2', email: 'x@y.com', factors: [] }
    aalResult = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null }
    const res = await call()
    expect(res.status).not.toBe(403)
  })
})

describe('B3: the Team header does not claim "0 pending invites" for viewers who cannot see them', () => {
  it('pending count is rendered only when canInvite', () => {
    const src = read('components/team/TeamClient.tsx')
    expect(src).toContain("{canInvite && <> · {pendingInvites.length} pending invite")
    expect(src).not.toMatch(/\{members\.length\} active · \{pendingInvites\.length\} pending/)
  })
})
