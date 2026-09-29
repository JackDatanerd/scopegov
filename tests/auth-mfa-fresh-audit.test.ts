import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Regression coverage for the Auth+MFA fresh audit:
//  - /api/auth/mfa/enroll needs a fresh step-up before it STARTS a first enrolment
//  - /api/auth/step-up refuses TOTP unless a verified factor exists and is the one named
//  - /api/auth/mfa/verify reports a listFactors failure as unavailable, not "factor not found"

let user: any
let factors: { totp: any[]; all: any[] }
let listError: any
let stepUpResponse: Response | null
let mfaEnrolled: boolean
let enrolCalls: number
let verifyCalls: number
let grants: number

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
  createStatelessAuthClient: () => ({}),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user } }),
      getSession: async () => ({ data: { session: null } }),
      signOut: async () => ({ error: null }),
      mfa: {
        listFactors: async () => ({ data: listError ? null : factors, error: listError }),
        unenroll: async () => ({ error: null }),
        enroll: async () => { enrolCalls++; return { data: { id: 'f-new', totp: { qr_code: 'qr', secret: 's', uri: 'u' } }, error: null } },
        challengeAndVerify: async () => { verifyCalls++; return { error: null } },
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } }),
      },
    },
  }),
}))
vi.mock('@/lib/auth/step-up', async () => {
  const actual: any = await vi.importActual('@/lib/auth/step-up')
  return {
    ...actual,
    requireStepUp: async () => stepUpResponse,
    loadStepUpContext: async () => ({ payload: null, sessionKey: 's1', mfaEnrolled }),
    recordStepUpGrant: async () => { grants++; return true },
  }
})
vi.mock('@/lib/auth/attempt-limit', () => ({
  AUTH_ATTEMPT_LIMIT: { maxFailures: 5, windowSeconds: 300 },
  beginAuthAttempt: async () => ({ allowed: true, retryAfterSeconds: 0, failures: 1, attemptId: 'a1' }),
  releaseAuthAttempt: async () => {},
  clearAuthFailures: async () => {},
  lockedResponseBody: () => ({}),
}))
vi.mock('@/lib/auth/session', () => ({
  resolveActorName: async (_s: any, _u: any, f: string) => f,
  resolveActiveWorkspaceId: async () => 'w1',
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', () => ({ notifySecurityEvent: async () => undefined }))
vi.mock('@/lib/auth/backup-code-store', () => ({ issueBackupCodes: async () => ['AAAAAA-BBBBBB'] }))
vi.mock('@/lib/auth/security-audit', () => ({ logSecurityAudit: async () => undefined }))
vi.mock('@/lib/auth/login-audit', () => ({ logLoginOnce: async () => true }))
vi.mock('@/lib/email/templates', () => ({
  sendAccountLockedEmail: async () => ({}), sendMfaEnabledEmail: async () => ({}),
}))

const req = (url: string, body?: any) =>
  new NextRequest('http://localhost' + url, {
    method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  user = { id: 'u1', email: 'a@b.co', user_metadata: {}, factors: [] }
  factors = { totp: [], all: [] }
  listError = null
  stepUpResponse = null
  mfaEnrolled = false
  enrolCalls = 0; verifyCalls = 0; grants = 0
})

describe('POST /api/auth/mfa/enroll', () => {
  const post = async () => (await import('../app/api/auth/mfa/enroll/route')).POST()

  it('asks for a step-up before starting a first enrolment, and starts nothing', async () => {
    stepUpResponse = new Response(JSON.stringify({ code: 'step_up_required', methods: ['password'] }), { status: 401 })
    const res = await post()
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('step_up_required')
    expect(enrolCalls).toBe(0)
  })

  it('enrols once the step-up is satisfied', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).factorId).toBe('f-new')
    expect(enrolCalls).toBe(1)
  })

  it('an already-enrolled account gets 409 without a challenge', async () => {
    factors = { totp: [{ id: 'f1', status: 'verified' }], all: [{ id: 'f1', status: 'verified', factor_type: 'totp' }] }
    stepUpResponse = new Response('{}', { status: 401 }) // would fail the request if it were consulted
    const res = await post()
    expect(res.status).toBe(409)
    expect(enrolCalls).toBe(0)
  })
})

describe('POST /api/auth/step-up (totp)', () => {
  const post = async (body: any) => (await import('../app/api/auth/step-up/route')).POST(req('/api/auth/step-up', body))
  const totp = { method: 'totp', factorId: 'f1', code: '123456' }

  it('refuses TOTP when the account has no verified factor (it would complete an enrolment)', async () => {
    mfaEnrolled = false
    factors = { totp: [], all: [{ id: 'f1', status: 'unverified', factor_type: 'totp' }] }
    const res = await post(totp)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('totp_not_available')
    expect(verifyCalls).toBe(0)
    expect(grants).toBe(0)
  })

  it('refuses a factor id that is not the caller\'s verified factor', async () => {
    mfaEnrolled = true
    factors = { totp: [{ id: 'other', status: 'verified' }], all: [] }
    const res = await post(totp)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('factor_not_found')
    expect(verifyCalls).toBe(0)
  })

  it('a listFactors failure is unavailable, not a wrong code', async () => {
    mfaEnrolled = true
    listError = { message: 'boom' }
    const res = await post(totp)
    expect(res.status).toBe(502)
    expect(verifyCalls).toBe(0)
  })

  it('confirms against the verified factor and records the grant', async () => {
    mfaEnrolled = true
    factors = { totp: [{ id: 'f1', status: 'verified' }], all: [] }
    const res = await post(totp)
    expect(res.status).toBe(200)
    expect(verifyCalls).toBe(1)
    expect(grants).toBe(1)
  })
})

describe('POST /api/auth/mfa/verify', () => {
  it('reports a listFactors failure as unavailable rather than "authenticator no longer registered"', async () => {
    listError = { message: 'boom' }
    const { POST } = await import('../app/api/auth/mfa/verify/route')
    const res = await POST(req('/api/auth/mfa/verify', { factorId: 'f1', code: '123456' }))
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('verify_unavailable')
    expect(verifyCalls).toBe(0)
  })
})
