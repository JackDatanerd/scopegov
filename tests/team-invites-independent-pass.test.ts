// tests/team-invites-independent-pass.test.ts
//
// Regression tests for the Team & Invites independent pass:
//   B1  — workspace delete → restore resurrected pending invites as ghost ACTIVE members
//   H1  — the seat limit was a read-then-write with nothing serializing the two
//   gap — pending invites whose sender lost the authority to grant them
//
// The source-text checks (delete route, migration 112) follow tests/rls-contract.test.ts: they pin the
// exact shape of the fix so it can't be quietly reverted. The behavioural ones use the same call-aware
// Proxy fake as tests/settings-team-repass-3.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
const rpcCalls: string[] = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any
let postWriteResult: { ok: boolean; message?: string } = { ok: true }

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
  createServiceClient: () => ({
    from: (t: string) => chain(t),
    rpc: async (name: string) => { rpcCalls.push(name); return { data: 0, error: null } },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', async () => {
  const actual: any = await vi.importActual('@/lib/utils/notify')
  return { ...actual, notifyUsers: async () => undefined, notifyMembersWithPermission: async () => undefined }
})
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async () => ({ ok: true }) }))
vi.mock('@/lib/email/templates', () => ({
  sendMemberAccessChangedEmail: async () => undefined,
  sendMemberRoleChangedEmail: async () => undefined,
}))
vi.mock('@/lib/utils/seat-limit', () => ({
  checkSeatLimit: async () => ({ ok: true }),
  seatLimitBreachedAfterWrite: async () => postWriteResult,
}))

const mkSession = (extra: any = {}) => ({
  id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x.com',
  agencyName: 'Acme', workspaceName: 'Acme', planTier: 'starter',
  permissions: ['INVITE_MEMBERS'], ...extra,
})

const patchReactivate = async (id = 'm1') => {
  const { PATCH } = await import('@/app/api/team/[id]/route')
  const req = new NextRequest(`http://localhost/api/team/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
  })
  return PATCH(req, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  calls.length = 0
  rpcCalls.length = 0
  postWriteResult = { ok: true }
  session = mkSession()
  resolver = () => ({ data: null, error: null })
})

const updates = () => calls.flatMap(c => c.ops.filter(o => o.name === 'update').map(o => ({ table: c.table, payload: o.args[0] })))

describe('B1: reactivating a deactivated row that never joined', () => {
  it('refuses a deactivated invite row that has a user_id but no joined_at (an invite to an existing account)', async () => {
    resolver = (table, ops) => {
      if (table === 'workspace_members' && ops.some(o => o.name === 'maybeSingle'))
        return { data: { id: 'm1', status: 'deactivated', user_id: 'u-existing', joined_at: null, deactivated_at: '2026-09-01T00:00:00Z', role_id: 'r1', effective_permissions: {}, users: { name: 'X', email: 'x@y.com', deleted_at: null } }, error: null }
      return { data: null, error: null }
    }
    const res = await patchReactivate()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/never accepted/i)
    expect(updates()).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
  })

  it('still reactivates a genuine former member (user_id and joined_at both set)', async () => {
    resolver = (table, ops) => {
      if (table === 'workspace_members' && ops.some(o => o.name === 'maybeSingle'))
        return { data: { id: 'm1', status: 'deactivated', user_id: 'u1', joined_at: '2026-01-01T00:00:00Z', deactivated_at: '2026-09-01T00:00:00Z', role_id: 'r1', effective_permissions: {}, users: { name: 'X', email: 'x@y.com', deleted_at: null } }, error: null }
      if (table === 'workspace_members' && ops.some(o => o.name === 'update')) return { data: [{ id: 'm1' }], error: null }
      return { data: null, error: null }
    }
    const res = await patchReactivate()
    expect(res.status).toBe(200)
    expect(rpcCalls).toContain('restore_member_projects')
  })
})

describe('H1: reactivation loses a seat race', () => {
  it('puts the member back as deactivated, keeps their original deactivated_at, and never restores projects', async () => {
    postWriteResult = { ok: false, message: 'This workspace is at its 2-seat limit on the Starter plan.' }
    resolver = (table, ops) => {
      if (table === 'workspace_members' && ops.some(o => o.name === 'maybeSingle'))
        return { data: { id: 'm1', status: 'deactivated', user_id: 'u1', joined_at: '2026-01-01T00:00:00Z', deactivated_at: '2026-09-01T00:00:00Z', role_id: 'r1', effective_permissions: {}, users: { name: 'X', email: 'x@y.com', deleted_at: null } }, error: null }
      if (table === 'workspace_members' && ops.some(o => o.name === 'update') && ops.some(o => o.name === 'select')) return { data: [{ id: 'm1' }], error: null }
      return { data: null, error: null }
    }
    const res = await patchReactivate()
    expect(res.status).toBe(409)
    const ups = updates()
    expect(ups[0].payload).toMatchObject({ status: 'active', deactivated_at: null })
    expect(ups[1].payload).toEqual({ status: 'deactivated', deactivated_at: '2026-09-01T00:00:00Z' })
    expect(rpcCalls).not.toContain('restore_member_projects')
  })
})

describe('seatLimitBreachedAfterWrite (real implementation)', () => {
  // The module is mocked above for the route tests, so pull the real one.
  async function real() { return vi.importActual<any>('@/lib/utils/seat-limit') }
  function countingService(count: number, error: unknown = null) {
    const chainer = (): any => new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') return (res: any, rej: any) => Promise.resolve({ count, error }).then(res, rej)
        return () => chainer()
      },
    })
    return { from: () => chainer() }
  }

  it('is fine when the count INCLUDING the caller\'s own row is exactly the limit (starter = 2)', async () => {
    const { seatLimitBreachedAfterWrite } = await real()
    expect((await seatLimitBreachedAfterWrite(countingService(2), 'w', 'starter', ['active'])).ok).toBe(true)
  })
  it('reports a breach when the count exceeds the limit — the caller lost the race', async () => {
    const { seatLimitBreachedAfterWrite } = await real()
    const r = await seatLimitBreachedAfterWrite(countingService(3), 'w', 'starter', ['active'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('2-seat')
  })
  it('fails open on a query error, like checkSeatLimit', async () => {
    const { seatLimitBreachedAfterWrite } = await real()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await seatLimitBreachedAfterWrite(countingService(99, { message: 'boom' }), 'w', 'starter', ['active'])).ok).toBe(true)
    spy.mockRestore()
  })
  it('has no opinion on a tier with no seat cap', async () => {
    const { seatLimitBreachedAfterWrite } = await real()
    expect((await seatLimitBreachedAfterWrite(countingService(999), 'w', 'nonsense', ['active'])).ok).toBe(true)
  })
})

describe('inviterGrantAllowed (pure half of inviterMayStillGrant)', () => {
  const role = { VIEW_ALL_PROJECTS: true, VIEW_FINANCIALS: true }
  it('allows an inviter who holds INVITE_MEMBERS and the whole role', async () => {
    const { inviterGrantAllowed } = await import('@/lib/utils/invite-authority')
    expect(inviterGrantAllowed({ INVITE_MEMBERS: true, ...role }, role)).toBe(true)
  })
  it('refuses when the inviter is gone (no permissions), lost INVITE_MEMBERS, or was demoted below the role', async () => {
    const { inviterGrantAllowed } = await import('@/lib/utils/invite-authority')
    expect(inviterGrantAllowed(undefined, role)).toBe(false)
    expect(inviterGrantAllowed(role, role)).toBe(false)
    expect(inviterGrantAllowed({ INVITE_MEMBERS: true, VIEW_ALL_PROJECTS: true }, role)).toBe(false)
  })
  it('cannot judge a role with no permission map, so it is allowed (matches inviterMayStillGrant)', async () => {
    const { inviterGrantAllowed } = await import('@/lib/utils/invite-authority')
    expect(inviterGrantAllowed({ INVITE_MEMBERS: true }, null)).toBe(true)
  })
})

describe('B1 source contracts', () => {
  const root = path.join(__dirname, '..')
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

  it('workspace/delete only deactivates ACTIVE members (never invites)', () => {
    const src = read('app/api/workspace/delete/route.ts')
    const at = src.indexOf(".update({ status: 'deactivated', deactivated_at: now })")
    expect(at).toBeGreaterThan(-1)
    const stmt = src.slice(at, at + 200)
    expect(stmt).toContain(".eq('status', 'active')")
    expect(stmt).not.toContain(".neq('status', 'deactivated')")
  })

  it('migration 112 only reactivates rows that were really members, heals ghosts, and adds the CHECK', () => {
    const sql = read('supabase/migrations/112_restore_workspace_skips_unaccepted_invites.sql')
    expect(sql).toMatch(/AND user_id IS NOT NULL AND joined_at IS NOT NULL;/)
    expect(sql).toMatch(/DELETE FROM public\.workspace_members WHERE status = 'active' AND user_id IS NULL;/)
    expect(sql).toMatch(/CHECK \(status <> 'active' OR user_id IS NOT NULL\)/)
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.restore_workspace_atomic(uuid, uuid) TO service_role')
  })

  it('migration numbers stay unique (112 must not collide with a concurrently-added migration)', () => {
    const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => /^\d+_/.test(f))
    const nums = files.map(f => parseInt(f, 10))
    expect(new Set(nums).size).toBe(nums.length)
    expect(files.some(f => f.startsWith('112_restore_workspace_skips_unaccepted_invites'))).toBe(true)
  })
})
