import { describe, it, expect, vi, beforeEach } from 'vitest'

// The real middleware, driven through a mocked Supabase client. Regression coverage for:
//  - new workspace owners being stranded in onboarding by the forced-MFA gate
//  - refreshed session cookies not reaching the route handler that runs after the middleware

let state: any
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, opts: any) => ({
    auth: {
      getUser: async () => {
        // A real refresh writes the rotated tokens through setAll() while getUser() runs.
        if (state.refreshTo) opts.cookies.setAll([{ name: 'sb-test-auth-token', value: state.refreshTo, options: { path: '/' } }])
        return { data: { user: state.user } }
      },
      signOut: async () => ({}),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: state.aal }) },
    },
    rpc: async () => ({ data: state.gate, error: state.gateError ?? null }),
  }),
}))

import { NextRequest } from 'next/server'
import { middleware } from '../middleware'

const call = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
  middleware(new NextRequest('http://localhost' + path, { method, headers })) as Promise<any>

beforeEach(() => {
  state = {
    user: { id: 'u1', factors: [] },
    aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
    // The exact state right after POST /api/workspace/create: an Owner (MFA-mandatory) mid-onboarding.
    gate: { deleted: false, has_workspace: true, onboarding_complete: false, must_enroll_mfa: true },
    refreshTo: null,
  }
})

const passes = (res: any) => !!res.headers.get('x-middleware-next')

describe('forced-MFA enrolment gate vs. onboarding', () => {
  it.each([
    ['POST', '/api/workspace/branding'],
    ['POST', '/api/workspace/defaults'],
    ['POST', '/api/workspace/settings'],
    ['GET',  '/api/workspace/onboarding-status'],
    ['POST', '/api/workspace/complete-onboarding'],
    ['GET',  '/api/workspace/restore'],
    ['POST', '/api/team/invite'],
    ['GET',  '/api/team/roles'],
  ])('%s %s is reachable while onboarding is unfinished', async (method, path) => {
    expect(passes(await call(path, method))).toBe(true)
  })

  it('the wizard page itself is reachable', async () => {
    expect(passes(await call('/onboarding'))).toBe(true)
  })

  it('but the rest of the API stays blocked until MFA is set up', async () => {
    for (const path of ['/api/projects', '/api/invoices', '/api/team/roles/abc', '/api/auth/change-password']) {
      const res = await call(path, 'POST')
      expect(res.status, path).toBe(401)
      expect((await res.json()).error).toMatch(/two-factor enrollment/i)
    }
  })

  it('pages are still funnelled to the wizard first', async () => {
    const res = await call('/dashboard')
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')).pathname).toBe('/onboarding')
  })

  it('once onboarding is complete the same routes are gated and pages go to /mfa-setup', async () => {
    state.gate = { ...state.gate, onboarding_complete: true }
    expect((await call('/api/workspace/branding', 'POST')).status).toBe(401)
    const page = await call('/dashboard')
    expect(new URL(page.headers.get('location')).pathname).toBe('/mfa-setup')
  })

  it('the MFA setup routes themselves are always reachable', async () => {
    state.gate = { ...state.gate, onboarding_complete: true }
    expect(passes(await call('/mfa-setup'))).toBe(true)
    expect(passes(await call('/api/auth/mfa/enroll', 'POST'))).toBe(true)
  })

  it('an enrolled account (aal2) is not gated', async () => {
    state.user = { id: 'u1', factors: [{ status: 'verified' }] }
    state.aal = { currentLevel: 'aal2', nextLevel: 'aal2' }
    state.gate = { ...state.gate, onboarding_complete: true }
    expect(passes(await call('/api/projects', 'POST'))).toBe(true)
  })

  it('a password-only session for an enrolled account must complete the challenge first', async () => {
    state.user = { id: 'u1', factors: [{ status: 'verified' }] }
    state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' }
    state.gate = { ...state.gate, onboarding_complete: true }
    expect((await call('/api/projects', 'POST')).status).toBe(401)
    expect(new URL((await call('/dashboard')).headers.get('location')).pathname).toBe('/mfa-challenge')
  })

  it('fails CLOSED (503) when the gate lookup errors', async () => {
    state.gate = null
    state.gateError = { message: 'boom' }
    expect((await call('/api/projects', 'POST')).status).toBe(503)
  })

  it('unauthenticated API calls are 401, public routes pass', async () => {
    state.user = null
    expect((await call('/api/projects')).status).toBe(401)
    expect(passes(await call('/legal/terms'))).toBe(true)
  })
})

describe('session refresh reaches the handler that runs after the middleware', () => {
  it('forwards the ROTATED cookie downstream and sets it on the response', async () => {
    state.user = { id: 'u1', factors: [{ status: 'verified' }] }
    state.aal = { currentLevel: 'aal2', nextLevel: 'aal2' }
    state.gate = { deleted: false, has_workspace: true, onboarding_complete: true, must_enroll_mfa: false }
    state.refreshTo = 'NEW-TOKEN'
    const res = await call('/api/projects', 'GET', { cookie: 'sb-test-auth-token=OLD-TOKEN' })
    expect(res.headers.get('x-middleware-request-cookie')).toContain('NEW-TOKEN')
    expect(res.headers.get('x-middleware-request-cookie')).not.toContain('OLD-TOKEN')
    expect(res.headers.get('set-cookie')).toContain('sb-test-auth-token=NEW-TOKEN')
  })

  it('rotated cookies survive a redirect too', async () => {
    state.gate = { ...state.gate, onboarding_complete: false }
    state.refreshTo = 'NEW-TOKEN'
    const res = await call('/dashboard', 'GET', { cookie: 'sb-test-auth-token=OLD-TOKEN' })
    expect(res.status).toBe(307)
    expect(res.headers.get('set-cookie')).toContain('sb-test-auth-token=NEW-TOKEN')
  })
})
