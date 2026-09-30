// tests/team-invites-independent-pass-3.test.ts
//
// Regression tests for the Team & Invites independent pass 3 (see CHANGES-team-invites-independent-pass-3.txt).
// Same call-aware fake Supabase client as tests/settings-team-repass-2.test.ts: the real route handlers run,
// only the client, the session and outbound side effects are faked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { approvalPermissionOrphanedBy } from '@/lib/utils/admin-floor'
import { roleGrantedAtAcceptance } from '@/lib/utils/invite-authority'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
const rpcCalls: Array<{ name: string; args: any }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any

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
const first = (ops: Op[]) => ops[0]?.name
const has = (ops: Op[], n: string) => ops.some(o => o.name === n)
const arg = (ops: Op[], n: string) => ops.find(o => o.name === n)?.args

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (t: string) => chain(t),
    rpc: async (name: string, args: any) => { rpcCalls.push({ name, args }); return { data: [], error: null } },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', async () => {
  const actual: any = await vi.importActual('@/lib/utils/notify')
  return Object.fromEntries(Object.keys(actual).map(k => [k, async () => undefined]))
})
vi.mock('@/lib/utils/rate-limit', () => ({ checkInviteRateLimit: async () => ({ allowed: true }) }))
vi.mock('@/lib/utils/seat-limit', () => ({ checkSeatLimit: async () => ({ ok: true }), seatLimitBreachedAfterWrite: async () => ({ ok: true }) }))

const ALL = [
  'VIEW_OWN_PROJECTS', 'VIEW_ALL_PROJECTS', 'VIEW_FINANCIALS', 'VIEW_CLIENT_DATA', 'CREATE_PROJECTS', 'EDIT_SOW', 'SEND_SOW',
  'CREATE_CHANGE_ORDERS', 'SEND_CHANGE_ORDERS', 'APPROVE_FLAGS', 'GRANT_EXCEPTIONS',
  'MARK_PROJECT_COMPLETE', 'ASSIGN_TEAM_MEMBERS', 'SUBMIT_GUARDIAN_CHECKS', 'ACCESS_GUARDIAN_HISTORY',
  'INVITE_MEMBERS', 'MANAGE_ROLES', 'MANAGE_BILLING', 'DELETE_PROJECTS', 'VIEW_AUDIT_LOG', 'MANAGE_WORKSPACE_SETTINGS',
  'SEND_INVOICES', 'APPROVE_DOCUMENTS', 'VIEW_PORTFOLIO',
]
const mkSession = (permissions: string[], extra: any = {}) => ({
  id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x.com', agencyName: 'Acme', workspaceName: 'Acme', planTier: 'agency', permissions, ...extra,
})
const req = (url: string, method: string, body?: any) =>
  new NextRequest('http://localhost' + url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const P = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => { calls.length = 0; rpcCalls.length = 0; resolver = () => ({ data: null, error: null }) })

async function fakeResend(outcome: 'ok' | 'reject') {
  process.env.RESEND_API_KEY = 're_test'; process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
  const send = await import('@/lib/email/send')
  const sent: any[] = []
  ;(send as any).__setResendForTests({
    emails: { send: async (b: any) => { sent.push(b); return outcome === 'ok' ? { data: { id: 'e1' }, error: null } : { data: null, error: { message: 'nope' } } } },
  })
  return sent
}

const pendingRow = (over: any = {}) => ({
  id: 'm1', status: 'invited', invited_email: 'new@x.com', user_id: null, invited_by: 'u9', role_id: 'r1',
  invite_token: 'OLD-TOKEN', invite_token_expires_at: '2099-01-01T00:00:00Z', roles: { name: 'Viewer', permissions: { VIEW_ALL_PROJECTS: true } }, users: null, ...over,
})

// ═════════════════════════════════════════════════════════════════════════
// 1 — Resend's compare-and-swap must include the status, not just the token
// ═════════════════════════════════════════════════════════════════════════
describe('POST /api/team/[id]/resend — cannot resurrect an accepted member', () => {
  it('only re-issues a row that is still invited/expired (accept leaves the token on the row)', async () => {
    await fakeResend('ok')
    session = mkSession(['INVITE_MEMBERS', 'VIEW_ALL_PROJECTS'])
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select') return { data: pendingRow(), error: null }
      if (t === 'workspace_members' && first(ops) === 'update') return { data: [{ id: 'm1' }], error: null }
      if (t === 'workspaces') return { data: { name: 'Acme', agency_name: 'Acme' }, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/[id]/resend/route')
    const res = await POST(req('/api/team/m1/resend', 'POST'), P('m1'))
    expect(res.status).toBe(200)
    const upd = calls.find(c => c.table === 'workspace_members' && first(c.ops) === 'update')!
    const guard = arg(upd.ops, 'in')
    expect(guard).toEqual(['status', ['invited', 'expired']])
    expect(arg(upd.ops, 'eq')).toBeTruthy()
    expect(upd.ops.some(o => o.name === 'eq' && o.args[0] === 'invite_token' && o.args[1] === 'OLD-TOKEN')).toBe(true)
  })

  it('409s when nothing matched (the row was accepted or revoked between read and write)', async () => {
    const sent = await fakeResend('ok')
    session = mkSession(['INVITE_MEMBERS', 'VIEW_ALL_PROJECTS'])
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select') return { data: pendingRow(), error: null }
      if (t === 'workspace_members' && first(ops) === 'update') return { data: [], error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/[id]/resend/route')
    const res = await POST(req('/api/team/m1/resend', 'POST'), P('m1'))
    expect(res.status).toBe(409)
    expect(sent.length).toBe(0)
  })

  it('the failed-send rollback is also status-guarded', async () => {
    await fakeResend('reject')
    session = mkSession(['INVITE_MEMBERS', 'VIEW_ALL_PROJECTS'])
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select') return { data: pendingRow(), error: null }
      if (t === 'workspace_members' && first(ops) === 'update') return { data: [{ id: 'm1' }], error: null }
      if (t === 'workspaces') return { data: { name: 'Acme', agency_name: 'Acme' }, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/[id]/resend/route')
    const json = await (await POST(req('/api/team/m1/resend', 'POST'), P('m1'))).json()
    expect(json.emailFailed).toBe(true)
    const updates = calls.filter(c => c.table === 'workspace_members' && first(c.ops) === 'update')
    expect(updates.length).toBe(2)
    expect(updates[1].ops.some(o => o.name === 'eq' && o.args[0] === 'status' && o.args[1] === 'invited')).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// 2 — an invite with no role is judged against the default role it will really get
// ═════════════════════════════════════════════════════════════════════════
describe('invites with no role are checked against the default role', () => {
  const bigDefault = { id: 'r-def', name: 'Admin', permissions: { MANAGE_BILLING: true, VIEW_ALL_PROJECTS: true } }

  it('roleGrantedAtAcceptance resolves an explicit role or, with none, the workspace default', async () => {
    const seen: Op[][] = []
    const svc = {
      from: (t: string) => {
        const b: any = new Proxy(function () {}, {
          get(_x, prop: string) {
            if (prop === 'maybeSingle') return async () => ({ data: { id: t, name: 'n', permissions: {} }, error: null })
            return (...args: any[]) => { (seen[seen.length - 1] ||= []).push({ name: prop, args }); return b }
          },
        })
        seen.push([])
        return b
      },
    }
    await roleGrantedAtAcceptance(svc, 'w1', 'r1')
    await roleGrantedAtAcceptance(svc, 'w1', null)
    expect(seen[0].some(o => o.name === 'eq' && o.args[0] === 'id' && o.args[1] === 'r1')).toBe(true)
    expect(seen[1].some(o => o.name === 'eq' && o.args[0] === 'is_default' && o.args[1] === true)).toBe(true)
  })

  it('PATCH: clearing a pending invite\u2019s role is refused when the default role is beyond the actor', async () => {
    session = mkSession(['MANAGE_ROLES', 'INVITE_MEMBERS', 'VIEW_ALL_PROJECTS'])
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select')
        return { data: { user_id: null, role_id: 'r1', status: 'invited', permission_overrides: null, effective_permissions: { VIEW_ALL_PROJECTS: true }, users: null }, error: null }
      if (t === 'roles') return { data: bigDefault, error: null }
      return { data: null, error: null }
    }
    const { PATCH } = await import('@/app/api/team/[id]/route')
    const res = await PATCH(req('/api/team/m1', 'PATCH', { roleId: null }), P('m1'))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/default role/i)
    expect(rpcCalls.length).toBe(0)
  })

  it('PATCH: clearing an ACTIVE member\u2019s role is unaffected (null there really means no role)', async () => {
    session = mkSession(['MANAGE_ROLES', 'INVITE_MEMBERS', 'VIEW_ALL_PROJECTS'])
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select')
        return { data: { user_id: 'u2', role_id: 'r1', status: 'active', permission_overrides: null, effective_permissions: { VIEW_ALL_PROJECTS: true }, users: { name: 'B', email: 'b@x.com' } }, error: null }
      if (t === 'roles') return { data: { name: 'Viewer', permissions: { VIEW_ALL_PROJECTS: true } }, error: null }
      return { data: [], error: null }
    }
    const { PATCH } = await import('@/app/api/team/[id]/route')
    await PATCH(req('/api/team/m1', 'PATCH', { roleId: null }), P('m1'))
    expect(rpcCalls.some(c => c.name === 'update_member_permissions_atomic')).toBe(true)
  })

  it('Resend: refuses a role-less invite whose default role the resender could not have issued', async () => {
    await fakeResend('ok')
    session = mkSession(['INVITE_MEMBERS'])
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select') return { data: pendingRow({ role_id: null, roles: null }), error: null }
      if (t === 'roles') return { data: bigDefault, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/[id]/resend/route')
    const res = await POST(req('/api/team/m1/resend', 'POST'), P('m1'))
    expect(res.status).toBe(403)
    expect(calls.some(c => c.table === 'workspace_members' && first(c.ops) === 'update')).toBe(false)
  })

  it('Copy link: same refusal for a role-less invite', async () => {
    session = mkSession(['INVITE_MEMBERS'])
    resolver = (t, ops) => {
      if (t === 'workspace_members' && first(ops) === 'select') return { data: pendingRow({ role_id: null, roles: null }), error: null }
      if (t === 'roles') return { data: bigDefault, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/[id]/link/route')
    const res = await POST(req('/api/team/m1/link', 'POST'), P('m1'))
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// 3 — no invite to a deleted account
// ═════════════════════════════════════════════════════════════════════════
describe('POST /api/team/invite — a deleted account', () => {
  it('is refused before any row is written', async () => {
    session = mkSession(ALL)
    resolver = (t, ops) => {
      if (t === 'users') return { data: { id: 'u-gone', deleted_at: '2026-09-20T00:00:00Z' }, error: null }
      if (t === 'roles') return { data: null, error: null }
      if (t === 'workspace_members' && first(ops) === 'select') return { data: [], error: null }
      if (t === 'workspace_members' && first(ops) === 'insert') return { data: { id: 'new-member' }, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/invite/route')
    const res = await POST(req('/api/team/invite', 'POST', { email: 'gone@x.com' }))
    expect(res.status).toBe(409)
    expect(calls.some(c => c.table === 'workspace_members' && (first(c.ops) === 'insert' || has(c.ops, 'insert')))).toBe(false)
  })

  it('a live account still gets its invite', async () => {
    await fakeResend('ok')
    session = mkSession(ALL)
    resolver = (t, ops) => {
      if (t === 'users') return { data: { id: 'u-live', deleted_at: null }, error: null }
      if (t === 'roles') return { data: null, error: null }
      if (t === 'workspace_members' && first(ops) === 'select') return { data: [], error: null }
      if (t === 'workspace_members' && has(ops, 'insert')) return { data: { id: 'new-member' }, error: null }
      if (t === 'workspaces') return { data: { name: 'Acme', agency_name: 'Acme' }, error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/invite/route')
    const res = await POST(req('/api/team/invite', 'POST', { email: 'live@x.com' }))
    expect(res.status).toBe(200)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// 5 — the approval floor only fires when a holder is actually being removed
// ═════════════════════════════════════════════════════════════════════════
describe('approvalPermissionOrphanedBy', () => {
  it('is false when nobody active held it to begin with (nothing is being orphaned)', () => {
    const none = [{ id: 'a', effectivePermissions: { APPROVE_DOCUMENTS: false } }, { id: 'b', effectivePermissions: {} }]
    expect(approvalPermissionOrphanedBy(none as any, new Map([['pending-invite', { APPROVE_DOCUMENTS: false }]]))).toBe(false)
  })
  it('is still true when the only holder loses it', () => {
    const one = [{ id: 'a', effectivePermissions: { APPROVE_DOCUMENTS: true } }, { id: 'b', effectivePermissions: {} }]
    expect(approvalPermissionOrphanedBy(one as any, new Map([['a', { APPROVE_DOCUMENTS: false }]]))).toBe(true)
  })
  it('is false when another active member keeps it', () => {
    const two = [{ id: 'a', effectivePermissions: { APPROVE_DOCUMENTS: true } }, { id: 'b', effectivePermissions: { APPROVE_DOCUMENTS: true } }]
    expect(approvalPermissionOrphanedBy(two as any, new Map([['a', { APPROVE_DOCUMENTS: false }]]))).toBe(false)
  })
})
