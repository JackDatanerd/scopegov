import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const page = read('app/onboarding/page.tsx')

describe('G1 — the waiting screen offers an already-set-up workspace', () => {
  it('loads /api/workspace/list while gated on "waiting", excluding the waiting workspace and incomplete ones', () => {
    expect(page).toMatch(/gate !== 'waiting' \|\| !waitingFor\?\.workspaceId/)
    expect(page).toMatch(/w\.id !== waitingFor\.workspaceId && w\.onboardingComplete/)
  })
  it('renders switch buttons inside the waiting gate using switchToWorkspace', () => {
    const waiting = page.slice(page.indexOf("if (gate === 'waiting')"), page.indexOf("if (gate === 'switch_error')"))
    expect(waiting).toMatch(/waitingOthers\.map/)
    expect(waiting).toMatch(/switchToWorkspace\(w\.id\)/)
  })
})

describe('B1 — a step change clears any stale error banner', () => {
  it('has an effect keyed on step that clears error', () => {
    expect(page).toMatch(/useEffect\(\(\) => \{ setError\(''\) \}, \[step\]\)/)
  })
})

describe('B2 — the MFA notice is only shown when enrolment will really be forced', () => {
  it('asks the auth server for the assurance level on step 4', () => {
    expect(page).toMatch(/getAuthenticatorAssuranceLevel\(\)/)
    expect(page).toMatch(/data\.nextLevel !== 'aal1'/)
  })
  it('gates the notice on mfaEnrolled === false', () => {
    expect(page).toMatch(/mfaEnrolled === false && \(/)
    expect(page.match(/set up two-factor authentication, required for this role/g)?.length).toBe(1)
  })
})

describe('B3 — progress persistence does not round-trip to auth on every keystroke', () => {
  const start = page.indexOf('if (!restored || !workspaceId) return')
  // Compare against code only — the explanatory comment above the effect names getUser() on purpose.
  const effect = page.slice(start, page.indexOf('}, [restored, step, workspaceId', start))
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  it('reads the cached user id instead of calling getUser()', () => {
    expect(effect).toMatch(/userIdRef\.current/)
    expect(effect).not.toMatch(/getUser\(/)
  })
  it('captures the id once at mount', () => {
    expect(page).toMatch(/userIdRef\.current = user\.id/)
  })
})

describe('B4 — failed invite emails accumulate instead of being overwritten', () => {
  it('appends to inviteFailedEmails and never resets it on a later successful invite', () => {
    expect(page).toMatch(/setInviteFailedEmails\(prev => prev\.includes\(failed\) \? prev : \[\.\.\.prev, failed\]\)/)
    expect(page).not.toMatch(/setInviteNotice/)
  })
  it('only resets the list when a brand-new workspace starts', () => {
    expect(page.match(/setInviteFailedEmails\(\[\]\)/g)?.length).toBe(1)
  })
})
