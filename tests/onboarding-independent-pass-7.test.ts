import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Regression coverage for Onboarding independent pass 7.
//   B1  a finished owner who lands back on /onboarding (Back from /mfa-setup, a bookmark) got the
//       "Couldn't load your setup" retry gate: middleware answers GET /api/workspace/onboarding-status
//       with 401 { code: 'mfa_enrollment_required' } once the workspace is complete, and the mount effect
//       read every non-OK reply as a failed lookup. Reloading could only 401 again.
//   B2  the same 401 was swallowed by `if (!res.ok) return` in the 'waiting' and 'suspended' polls, so an
//       invitee on a default (MFA-mandatory) role never left the waiting screen after the creator finished.

let state: any
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
      signOut: async () => ({}),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: state.aal, error: null }) },
    },
    rpc: async () => ({ data: state.gate, error: null }),
  }),
}))

import { NextRequest } from 'next/server'
import { middleware } from '../middleware'

const call = (path: string) => middleware(new NextRequest('http://localhost' + path)) as Promise<any>

beforeEach(() => {
  state = {
    user: { id: 'u1', factors: [] },
    aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
    gate: { deleted: false, has_workspace: true, onboarding_complete: true, must_enroll_mfa: true },
  }
})

describe('the premise: what middleware answers the status route once onboarding is complete', () => {
  it('401 with code mfa_enrollment_required (not a 5xx, not a bare Unauthorized)', async () => {
    const res = await call('/api/workspace/onboarding-status')
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('mfa_enrollment_required')
  })

  it('still passes straight through while onboarding is unfinished', async () => {
    state.gate = { ...state.gate, onboarding_complete: false }
    expect(!!(await call('/api/workspace/onboarding-status')).headers.get('x-middleware-next')).toBe(true)
  })

  it('a pending second-factor challenge is answered with code mfa_challenge_required', async () => {
    state.user = { id: 'u1', factors: [{ status: 'verified' }] }
    state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' }
    const res = await call('/api/workspace/onboarding-status')
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('mfa_challenge_required')
  })
})

const page = readFileSync(join(process.cwd(), 'app/onboarding/page.tsx'), 'utf8')

describe('B1/B2 — the wizard treats that gated 401 as "already past onboarding"', () => {
  it('has one helper that matches exactly a 401 carrying one of the two MFA codes', () => {
    const fn = page.slice(page.indexOf('function isMfaGateResponse'), page.indexOf('const STEPS = ['))
    expect(fn).toContain('status === 401')
    expect(fn).toContain("'mfa_enrollment_required'")
    expect(fn).toContain("'mfa_challenge_required'")
  })

  it('B1: the mount effect checks it before it decides the lookup failed, and goes to /dashboard', () => {
    const start = page.indexOf("fetch('/api/workspace/onboarding-status')")
    const gated = page.indexOf('isMfaGateResponse(res.status, json)', start)
    const failed = page.indexOf('else statusFetchFailed = true', start)
    expect(start).toBeGreaterThan(0)
    expect(gated).toBeGreaterThan(start)
    expect(failed).toBeGreaterThan(gated)
    const block = page.slice(gated, failed)
    expect(block).toMatch(/router\.push\('\/dashboard'\)/)
    expect(block).toMatch(/return/)
  })

  it('B1: stale saved progress is dropped only when the gate says enrolment is owed (workspace is complete)', () => {
    const start = page.indexOf('isMfaGateResponse(res.status, json)', page.indexOf("fetch('/api/workspace/onboarding-status')"))
    const block = page.slice(start, page.indexOf('if (res.ok) status = json', start))
    expect(block).toMatch(/json\?\.code === 'mfa_enrollment_required'[\s\S]*localStorage\.removeItem/)
  })

  it('B1: a genuine failure (5xx / network) still reaches the retry gate', () => {
    expect(page).toContain('else statusFetchFailed = true')
    expect(page).toContain("setGate('status_error')")
  })

  it('B2: the waiting poll and the suspended poll both check it before ignoring a non-OK reply', () => {
    for (const marker of ["if (gate !== 'waiting') return", "if (gate !== 'suspended') return"]) {
      const from = page.indexOf(marker)
      expect(from, marker).toBeGreaterThan(0)
      const gated  = page.indexOf('isMfaGateResponse(res.status, json)', from)
      const ignore = page.indexOf('if (!res.ok) return', from)
      expect(gated, marker).toBeGreaterThan(from)
      expect(ignore, marker).toBeGreaterThan(gated)
      expect(page.slice(gated, ignore), marker).toMatch(/router\.push\('\/dashboard'\)/)
    }
  })

  it("B1/B2: discardWorkspace's post-delete re-check handles it too (stale otherWorkspaces snapshot)", () => {
    const from  = page.indexOf('async function discardWorkspace')
    const check = page.indexOf("fetch('/api/workspace/onboarding-status')", from)
    const gated = page.indexOf('isMfaGateResponse(res.status, json)', check)
    const newFlag = page.indexOf("router.replace('/onboarding?new=1')", check)
    expect(check).toBeGreaterThan(from)
    expect(gated).toBeGreaterThan(check)
    expect(newFlag).toBeGreaterThan(gated)
    expect(page.slice(gated, newFlag)).toMatch(/router\.push\('\/dashboard'\)/)
  })

  it('every status-route caller in the wizard is gate-aware (mount, discard, waiting, suspended)', () => {
    const uses = [...page.matchAll(/fetch\('\/api\/workspace\/onboarding-status'\)/g)].map(m => m.index as number)
    expect(uses.length).toBe(4)
    for (const i of uses) {
      const next = page.indexOf('isMfaGateResponse(res.status, json)', i)
      expect(next, `call at ${i}`).toBeGreaterThan(i)
      expect(next - i, `call at ${i} checks the gate within its own block`).toBeLessThan(1400)
    }
  })
})

describe('workspace-open comment no longer claims restorable workspaces are always onboarded', () => {
  const src = readFileSync(join(process.cwd(), 'app/(app)/workspace-open/page.tsx'), 'utf8')
  it('drops the false "already finished onboarding by definition" claim', () => {
    expect(src).not.toMatch(/has already finished onboarding by\s*\/\/\s*definition/)
    expect(src).toContain('Onboarding independent pass 7')
  })
})
