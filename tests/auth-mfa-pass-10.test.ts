import { describe, it, expect, vi, beforeEach } from 'vitest'

// Auth+MFA pass 10: the "does any membership require 2FA?" lookup fails CLOSED.
let memberError: any
let memberRows: any[]

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const q: any = {
        select: () => q, eq: () => q, delete: () => q, update: () => q, insert: () => q, order: () => q, limit: () => q, is: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (r: any) => r({ data: memberError ? null : memberRows, error: memberError }),
      }
      return q
    },
    rpc: async (fn: string) => ({ data: fn === 'user_has_password' ? true : null, error: null }),
  }),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.co', user_metadata: {}, factors: [{ id: 'f1', status: 'verified' }] } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' } }),
        listFactors: async () => ({ data: { totp: [{ id: 'f1', status: 'verified' }], all: [] }, error: null }),
        unenroll: vi.fn(async () => ({ error: null })),
      },
      getSession: async () => ({ data: { session: null } }),
      signOut: async () => ({ error: null }),
      refreshSession: async () => ({ error: null }),
      updateUser: vi.fn(async () => ({ error: null })),
    },
  }),
  createStatelessAuthClient: () => ({ auth: { signInWithPassword: async () => ({ data: {}, error: null }), signOut: async () => ({}) } }),
}))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUp: async () => null }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', () => ({ notifySecurityEvent: async () => {} }))
vi.mock('@/lib/email/templates', () => ({
  sendMfaDisabledEmail: async () => {}, sendPasswordChangedEmail: async () => {}, sendAccountLockedEmail: async () => {},
}))
vi.mock('@/lib/auth/security-audit', () => ({ logSecurityAudit: async () => {}, activeWorkspaceIdsForUser: async () => [] }))

import { userHasAnyMfaMandatoryMembership, userHasAnyMfaMandatoryMembershipOrAssume, MfaPolicyLookupError } from '@/lib/auth/session'

// These suites cover the ENFORCED path (MFA_ENFORCEMENT=required); the default is 'recommended' — see tests/mfa-recommended.test.ts.
process.env.MFA_ENFORCEMENT = 'required'

beforeEach(() => { memberError = null; memberRows = [] })

describe('userHasAnyMfaMandatoryMembership', () => {
  it('answers from the rows when the read succeeds', async () => {
    memberRows = [{ effective_permissions: { VIEW_OWN_PROJECTS: true } }]
    expect(await userHasAnyMfaMandatoryMembership('u1')).toBe(false)
    memberRows = [{ effective_permissions: { MANAGE_BILLING: true } }]
    expect(await userHasAnyMfaMandatoryMembership('u1')).toBe(true)
  })
  it('throws (does not answer "not mandatory") when the read fails', async () => {
    memberError = { message: 'db down' }
    await expect(userHasAnyMfaMandatoryMembership('u1')).rejects.toBeInstanceOf(MfaPolicyLookupError)
  })
  it('display variant assumes mandatory on failure', async () => {
    memberError = { message: 'db down' }
    expect(await userHasAnyMfaMandatoryMembershipOrAssume('u1')).toBe(true)
  })
})

describe('DELETE /api/auth/mfa/factors', () => {
  it('refuses with 503 and does not unenroll when the policy lookup fails', async () => {
    memberError = { message: 'db down' }
    const { DELETE } = await import('@/app/api/auth/mfa/factors/route')
    const res = await DELETE(new Request('http://x/api/auth/mfa/factors', { method: 'DELETE', body: JSON.stringify({ factorId: 'f1' }) }))
    expect(res.status).toBe(503)
  })
  it('still blocks a mandatory-role user (403) when the lookup works', async () => {
    memberRows = [{ effective_permissions: { MANAGE_ROLES: true } }]
    const { DELETE } = await import('@/app/api/auth/mfa/factors/route')
    const res = await DELETE(new Request('http://x/api/auth/mfa/factors', { method: 'DELETE', body: JSON.stringify({ factorId: 'f1' }) }))
    expect(res.status).toBe(403)
  })
})

describe('POST /api/auth/change-password', () => {
  it('answers 503 when the policy lookup fails', async () => {
    memberError = { message: 'db down' }
    const { POST } = await import('@/app/api/auth/change-password/route')
    const { NextRequest } = await import('next/server')
    const res = await POST(new NextRequest('http://x/api/auth/change-password', {
      method: 'POST', body: JSON.stringify({ password: 'a-long-unique-pass-9', currentPassword: 'old-pass-123' }),
    }))
    expect(res.status).toBe(503)
  })
})
