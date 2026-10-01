import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'fs'

// Auth+MFA pass 8:
//  - /api/auth/mfa/recover must not treat a listFactors failure as "no factors" (it spent every
//    backup code, answered ok and left the authenticator enrolled)
//  - invite sign-up must apply the "password can't be your email" rule
//  - the admin panel must be able to answer a step-up (host mounted, wrapper used)

let listErr: any
let deleted: string[]
let updates: any[]
let createUserCalls: number

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, is: () => q, limit: () => q,
        update: (v: any) => { updates.push(v); return q },
        maybeSingle: async () => ({
          data: table === 'workspace_members' ? {
            id: 'm1', status: 'invited', invite_token_expires_at: new Date(Date.now() + 86400_000).toISOString(),
            invited_email: 'jane.doe@agency.com', invited_by: 'u0', workspace_id: 'w1', role_id: 'r1',
            workspaces: { name: 'W', deleted_at: null, plan_tier: 'solo', trial_ends_at: null },
          } : null, error: null,
        }),
        then: (r: any) => r({ data: [{ id: 'c1' }], error: null }),
      }
      return q
    },
    auth: { admin: { mfa: { deleteFactor: async ({ id }: any) => { deleted.push(id); return { error: null } } } } },
  }),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.co', user_metadata: {}, factors: [{ id: 'f1', status: 'verified' }] } } }),
      signOut: async () => ({ error: null }), refreshSession: async () => ({ error: null }),
      mfa: { listFactors: async () => ({ data: listErr ? null : { all: [{ id: 'f1' }] }, error: listErr }) },
    },
  }),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { admin: { createUser: async () => { createUserCalls++; return { data: null, error: { message: 'stop' } } }, deleteUser: async () => ({}) } } }),
}))
vi.mock('@/lib/auth/attempt-limit', () => ({
  AUTH_ATTEMPT_LIMIT: { maxFailures: 5, windowSeconds: 300 },
  beginAuthAttempt: async () => ({ allowed: true, retryAfterSeconds: 0, failures: 1, attemptId: 'a1' }),
  releaseAuthAttempt: async () => {}, clearAuthFailures: async () => {}, lockedResponseBody: () => ({}),
}))
vi.mock('@/lib/auth/session', () => ({ resolveActorName: async (_s: any, _u: any, f: string) => f, resolveActiveWorkspaceId: async () => 'w1' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', () => ({ notifySecurityEvent: async () => undefined, notifyMembersWithPermission: async () => undefined }))
vi.mock('@/lib/auth/security-audit', () => ({ logSecurityAudit: async () => undefined }))
vi.mock('@/lib/email/templates', () => ({ sendMfaDisabledEmail: async () => ({}), sendAccountLockedEmail: async () => ({}) }))
vi.mock('@/lib/utils/invite-authority', () => ({ inviterMayStillGrant: async () => true }))
vi.mock('@/lib/utils/seat-limit', () => ({ checkSeatLimit: async () => ({ ok: true }) }))

beforeEach(() => { listErr = null; deleted = []; updates = []; createUserCalls = 0 })

describe('POST /api/auth/mfa/recover', () => {
  const post = async () => (await import('../app/api/auth/mfa/recover/route')).POST(
    new Request('http://x/api/auth/mfa/recover', { method: 'POST', body: JSON.stringify({ code: 'AAAAAA-BBBBBB' }), headers: { 'content-type': 'application/json' } }))

  it('a listFactors failure gives the code back and reports failure — nothing is "recovered"', async () => {
    listErr = { message: 'transient' }
    const res = await post()
    expect(res.status).toBe(502)
    expect((await res.json()).ok).toBeUndefined()
    expect(deleted).toHaveLength(0)
    // the claim, then the restore — and no "retire every remaining code" update after it
    const last = updates[updates.length - 1]
    expect(last).toEqual({ used_at: null })
  })

  it('still recovers normally when the factor list loads', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(deleted).toEqual(['f1'])
  })
})

describe('POST /api/team/invite/[token]/signup', () => {
  it('refuses a password equal to the invited email address, before any account is created', async () => {
    const { POST } = await import('../app/api/team/invite/[token]/signup/route')
    const res = await POST(new NextRequest('http://x/api/team/invite/t/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jane', password: 'Jane.Doe@Agency.com', acceptedTerms: true }),
    }), { params: Promise.resolve({ token: 't' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/email/i)
    expect(createUserCalls).toBe(0)
  })
})

describe('platform admin step-up wiring', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('mounts the step-up host in the admin layout', () => {
    expect(read('app/(admin)/admin/layout.tsx')).toMatch(/<StepUpHost\s*\/>/)
  })
  it('sends the mutating admin actions through fetchWithStepUp', () => {
    for (const [file, base] of [
      ['app/(admin)/admin/users/[id]/page.tsx', '/api/admin/users/${id}/${path}'],
      ['app/(admin)/admin/workspaces/[id]/page.tsx', '/api/admin/workspaces/${id}/${path}'],
    ]) {
      const src = read(file)
      expect(src).toContain(`fetchWithStepUp(\`${base}\``)
      expect(src).not.toContain(`await fetch(\`${base}\``)
    }
  })
})
