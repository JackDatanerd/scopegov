// tests/team-invites-round16.test.ts
//
// Regression tests for Team & Invites round 16:
//   B1 — invite accept ignored users.deleted_at
//   B2 — a deactivated never-accepted row blocked re-inviting and couldn't be cleared
//   B3 — invite revoke deleted by id with no status guard
//   B4 — invite lookup read errors were reported as "invalid/expired"
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any
let authUser: any = { id: 'u1', email: 'a@b.com', user_metadata: {} }

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
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t), rpc: async () => ({ data: true, error: null }) }),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } }) },
    },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', async () => {
  const actual: any = await vi.importActual('@/lib/utils/notify')
  return { ...actual, notifyUsers: async () => undefined, notifyMembersWithPermission: async () => undefined }
})
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async () => ({ ok: true }) }))
vi.mock('@/lib/email/templates', () => ({
  sendInviteEmail: async () => undefined,
  sendMemberAccessChangedEmail: async () => undefined,
  sendMemberRoleChangedEmail: async () => undefined,
}))
vi.mock('@/lib/utils/seat-limit', () => ({
  checkSeatLimit: async () => ({ ok: true }),
  seatLimitBreachedAfterWrite: async () => ({ ok: true }),
}))
vi.mock('@/lib/utils/rate-limit', () => ({ checkInviteRateLimit: async () => ({ allowed: true }) }))
vi.mock('@/lib/utils/invite-authority', () => ({ inviterMayStillGrant: async () => true }))

const mkSession = () => ({
  id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x.com',
  agencyName: 'Acme', workspaceName: 'Acme', planTier: 'agency', permissions: ['INVITE_MEMBERS'],
})
const deletes = () => calls.filter(c => c.ops.some(o => o.name === 'delete'))

beforeEach(() => {
  calls.length = 0
  session = mkSession()
  authUser = { id: 'u1', email: 'a@b.com', user_metadata: {} }
  resolver = () => ({ data: null, error: null })
})

describe('B1: accept refuses a deleted account', () => {
  it('403s and never touches workspace_members', async () => {
    resolver = (table) => table === 'users' ? { data: { deleted_at: '2026-09-01T00:00:00Z' }, error: null } : { data: null, error: null }
    const { POST } = await import('@/app/api/team/invite/[token]/accept/route')
    const res = await POST(new NextRequest('http://localhost/api/team/invite/t/accept', { method: 'POST' }), { params: Promise.resolve({ token: 't' }) })
    expect(res.status).toBe(403)
    expect(calls.some(c => c.table === 'workspace_members')).toBe(false)
  })
})

describe('B4: invite read failures are 500s, not "invalid"', () => {
  const failing = (table: string) => table === 'workspace_members'
    ? { data: null, error: { message: 'connection reset' } } : { data: { deleted_at: null }, error: null }
  it('GET validate', async () => {
    resolver = failing
    const { GET } = await import('@/app/api/team/invite/[token]/route')
    const res = await GET(new NextRequest('http://localhost/api/team/invite/t'), { params: Promise.resolve({ token: 't' }) })
    expect(res.status).toBe(500)
  })
  it('accept', async () => {
    resolver = failing
    const { POST } = await import('@/app/api/team/invite/[token]/accept/route')
    const res = await POST(new NextRequest('http://localhost/api/team/invite/t/accept', { method: 'POST' }), { params: Promise.resolve({ token: 't' }) })
    expect(res.status).toBe(500)
  })
  it('signup', async () => {
    resolver = failing
    const { POST } = await import('@/app/api/team/invite/[token]/signup/route')
    const res = await POST(new NextRequest('http://localhost/api/team/invite/t/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jane', password: 'Str0ng-passw0rd!x', acceptedTerms: true }),
    }), { params: Promise.resolve({ token: 't' }) })
    expect(res.status).toBe(500)
  })
})

describe('B3: invite revoke only deletes never-accepted rows', () => {
  const del = async (row: any, removed: any) => {
    resolver = (table, ops) => {
      if (table !== 'workspace_members') return { data: null, error: null }
      if (ops.some(o => o.name === 'delete')) return { data: removed, error: null }
      if (ops.some(o => o.name === 'maybeSingle')) return { data: row, error: null }
      return { data: [], error: null }
    }
    const { DELETE } = await import('@/app/api/team/[id]/route')
    return DELETE(new NextRequest('http://localhost/api/team/m1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'm1' }) })
  }
  const invite = { id: 'm1', user_id: null, role_id: null, status: 'invited', joined_at: null, invited_email: 'x@y.com', effective_permissions: {}, users: null }

  it('status-guards the delete and reports a lost race as 409', async () => {
    const res = await del(invite, [])
    expect(res.status).toBe(409)
    const d = deletes()[0]
    expect(d.ops.some(o => o.name === 'or' && String(o.args[0]).includes('joined_at.is.null'))).toBe(true)
  })
  it('succeeds when the row was still a pending invite', async () => {
    expect((await del(invite, [{ id: 'm1' }])).status).toBe(200)
  })
})

describe('B2: deactivated never-accepted rows', () => {
  it('DELETE clears a leftover deactivated invite instead of 409 "already deactivated"', async () => {
    const row = { id: 'm1', user_id: 'u-old', role_id: null, status: 'deactivated', joined_at: null, invited_email: 'x@y.com', effective_permissions: {}, users: null }
    resolver = (table, ops) => {
      if (table !== 'workspace_members') return { data: null, error: null }
      if (ops.some(o => o.name === 'delete')) return { data: [{ id: 'm1' }], error: null }
      if (ops.some(o => o.name === 'maybeSingle')) return { data: row, error: null }
      return { data: [], error: null }
    }
    const { DELETE } = await import('@/app/api/team/[id]/route')
    const res = await DELETE(new NextRequest('http://localhost/api/team/m1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'm1' }) })
    expect(res.status).toBe(200)
  })

  const invitePost = async (rows: any[]) => {
    resolver = (table, ops) => {
      if (table === 'roles') return { data: { id: 'r1', name: 'Member', permissions: {} }, error: null }
      if (table === 'users') return { data: null, error: null }
      if (table === 'workspaces') return { data: { name: 'Acme', agency_name: 'Acme' }, error: null }
      if (table === 'workspace_members') {
        if (ops.some(o => o.name === 'insert')) return { data: { id: 'new' }, error: null }
        if (ops.some(o => o.name === 'delete')) return { data: null, error: null }
        return { data: rows, error: null }
      }
      return { data: null, error: null }
    }
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost'
    const { POST } = await import('@/app/api/team/invite/route')
    return POST(new NextRequest('http://localhost/api/team/invite', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@y.com', roleId: 'r1' }),
    }))
  }

  it('re-invite: a leftover deactivated invite is cleared, not answered with a Reactivate offer', async () => {
    const res = await invitePost([{ id: 'old', status: 'deactivated', user_id: 'u-old', invited_email: 'x@y.com', invite_token_expires_at: null, joined_at: null }])
    expect(res.status).toBe(200)
    const d = deletes()[0]
    expect(d.ops.find(o => o.name === 'in')?.args[1]).toContain('old')
  })

  it('re-invite: a real former member (joined_at set) still gets the Reactivate offer', async () => {
    const res = await invitePost([{ id: 'ex', status: 'deactivated', user_id: 'u-ex', invited_email: 'x@y.com', invite_token_expires_at: null, joined_at: '2026-01-01T00:00:00Z' }])
    expect(res.status).toBe(409)
    expect((await res.json()).reactivateMemberId).toBe('ex')
    expect(deletes()).toHaveLength(0)
  })
})
