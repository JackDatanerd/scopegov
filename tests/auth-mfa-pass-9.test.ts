import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Auth+MFA pass 9:
//  - recovery / admin resets clear the mfa_verify ledgers (no lockout on the replacement enrolment)
//  - recovery: a failed lookup/claim is an availability error, not a wrong code
//  - getSessionStrict throws on an infrastructure failure instead of answering "signed out"
//  - team reset-mfa refuses when the actor lacks authority in the target's other workspaces
//  - factors GET reports a listFactors failure
//  - logAudit skips a workspace-less row quietly

let cleared: any[]
let matchError: any
let rpcCalls: string[]
let userRowError: any
let listFactorsError: any

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    rpc: async (fn: string) => { rpcCalls.push(fn); return { data: fn === 'auth_attempt_begin' ? { allowed: true, attempt_id: 'a1', failures: 1, retry_after_seconds: 0 } : null, error: null } },
    from: (table: string) => {
      const q: any = {
        _t: table, _op: '',
        select: () => q, eq: () => q, is: () => q, limit: () => q, order: () => q,
        in: (col: string, vals: any) => { if (q._op === 'delete') cleared.push({ table, col, vals }); return q },
        delete: () => { q._op = 'delete'; return q },
        update: () => { q._op = 'update'; return q },
        maybeSingle: async () => table === 'users'
          ? { data: null, error: userRowError } : { data: null, error: null },
        then: (r: any) => r(table === 'user_mfa_backup_codes' && q._op === ''
          ? { data: null, error: matchError } : { data: [], error: null }),
      }
      return q
    },
    auth: { admin: { mfa: { deleteFactor: async () => ({ error: null }) } } },
  }),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.co', user_metadata: {}, factors: [{ id: 'f1', status: 'verified' }] } }, error: null }),
      signOut: async () => ({ error: null }), refreshSession: async () => ({ error: null }),
      mfa: { listFactors: async () => ({ data: listFactorsError ? null : { all: [{ id: 'f1' }], totp: [{ id: 'f1', status: 'verified' }] }, error: listFactorsError }) },
    },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: vi.fn(async () => true) }))
vi.mock('@/lib/utils/notify', () => ({ notifySecurityEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/email/templates', () => ({
  sendMfaDisabledEmail: vi.fn(async () => {}), sendAccountLockedEmail: vi.fn(async () => {}),
}))
vi.mock('@/lib/auth/security-audit', () => ({ logSecurityAudit: vi.fn(async () => {}), activeWorkspaceIdsForUser: vi.fn(async () => []) }))

beforeEach(() => { cleared = []; matchError = null; rpcCalls = []; userRowError = null; listFactorsError = null })

describe('mfa/recover availability errors', () => {
  it('a failed backup-code lookup releases the reservation and spends nothing', async () => {
    matchError = { message: 'boom' }
    const { POST } = await import('../app/api/auth/mfa/recover/route')
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ code: 'ABCDEF-234567' }) }))
    expect(res.status).toBe(502)
    expect(rpcCalls).toContain('auth_attempt_release')
  })
})

describe('mfa/factors GET', () => {
  it('reports a listFactors failure instead of enrolled:false', async () => {
    listFactorsError = { message: 'down' }
    const { GET } = await import('../app/api/auth/mfa/factors/route')
    const res = await GET()
    expect(res.status).toBe(502)
  })
})

describe('getSessionStrict', () => {
  it('throws SessionUnavailableError when the users lookup errors; getSession stays null', async () => {
    userRowError = { message: 'timeout' }
    const { getSession, getSessionStrict, SessionUnavailableError } = await import('../lib/auth/session')
    expect(await getSession()).toBeNull()
    await expect(getSessionStrict()).rejects.toBeInstanceOf(SessionUnavailableError)
  })
})

describe('mfaResetAuthorityGaps', () => {
  it('requires MANAGE_ROLES, a non-owner target and a ceiling in every other workspace', async () => {
    const { mfaResetAuthorityGaps } = await import('../lib/auth/mfa-reset-authority')
    const base = { targetUserId: 't', ownerByWorkspace: {} as any }
    const mk = (perms: any) => [{ workspace_id: 'B', effective_permissions: perms }]
    expect(mfaResetAuthorityGaps({ ...base, otherWorkspaceIds: ['B'], actorMemberships: [], targetMemberships: mk({ VIEW_ALL_PROJECTS: true }) })).toEqual(['B'])
    expect(mfaResetAuthorityGaps({ ...base, otherWorkspaceIds: ['B'], actorMemberships: mk({ VIEW_ALL_PROJECTS: true }), targetMemberships: mk({ VIEW_ALL_PROJECTS: true }) })).toEqual(['B'])
    expect(mfaResetAuthorityGaps({ ...base, otherWorkspaceIds: ['B'], actorMemberships: mk({ MANAGE_ROLES: true, VIEW_ALL_PROJECTS: true }), targetMemberships: mk({ VIEW_ALL_PROJECTS: true }) })).toEqual([])
    expect(mfaResetAuthorityGaps({ ...base, otherWorkspaceIds: ['B'], actorMemberships: mk({ MANAGE_ROLES: true }), targetMemberships: mk({ MANAGE_BILLING: true }) })).toEqual(['B'])
    expect(mfaResetAuthorityGaps({ ...base, ownerByWorkspace: { B: 't' }, otherWorkspaceIds: ['B'], actorMemberships: mk({ MANAGE_ROLES: true }), targetMemberships: mk({}) })).toEqual(['B'])
  })
})

describe('logAudit', () => {
  it('skips a row with no workspace without attempting an insert', async () => {
    vi.doUnmock('@/lib/utils/audit')
    vi.resetModules()
    const insert = vi.fn()
    const { logAudit } = await import('../lib/utils/audit')
    expect(await logAudit({ from: () => ({ insert }) }, { workspaceId: '', actorId: 'u', actorEmail: 'e', actorName: 'n', eventType: 'x', entityType: 'user' })).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })
})

describe('lockout clearing wiring', () => {
  it('recover, team reset and admin reset all clear the mfa_verify ledgers after removing the factor', async () => {
    const { readFileSync } = await import('fs')
    for (const f of ['app/api/auth/mfa/recover/route.ts', 'app/api/team/[id]/reset-mfa/route.ts', 'app/api/admin/users/[id]/reset-mfa/route.ts']) {
      expect(readFileSync(f, 'utf8'), f).toContain('clearMfaCodeLockouts(service')
    }
  })
  it('clearMfaCodeLockouts deletes both ledgers', async () => {
    const { clearMfaCodeLockouts } = await import('../lib/auth/attempt-limit')
    const calls: any[] = []
    const q: any = { delete: () => q, eq: (c: string, v: any) => { calls.push([c, v]); return q }, in: (c: string, v: any) => { calls.push([c, v]); return Promise.resolve({ error: null }) } }
    await clearMfaCodeLockouts({ from: () => q }, 'u1')
    expect(calls).toContainEqual(['kind', ['mfa_verify', 'mfa_verify_hook']])
  })
})
