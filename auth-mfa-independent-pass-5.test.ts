// tests/auth-mfa-independent-pass-5.test.ts
//
// Regression tests for the Auth + MFA independent pass, round 5 (source-level guards).
//   B1  Settings must decide "has a password" from auth.users (user_has_password), not only the
//       'email'-identity heuristic, or a Google-first person who set a password can never change it.
//   B2  Google sign-in on /login can create an account, so it must carry the terms version to the callback.
//   M1  DELETE /api/auth/mfa/factors only removes a VERIFIED factor of the caller.
//   M2  MfaSetupClient.handleVerify tolerates a non-JSON response; mfa-challenge can't redirect to itself.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('Auth+MFA pass 5', () => {
  it('B1: settings page asks user_has_password and passes the result to SettingsClient', () => {
    const src = read('app/(app)/settings/page.tsx')
    expect(src).toContain("rpc('user_has_password', { p_user: session.id })")
    expect(src).toContain('session={{ ...session, hasPasswordIdentity }}')
  })

  it('B2: LoginForm Google button sends terms and shows the notice', () => {
    const src = read('app/(auth)/login/LoginForm.tsx')
    expect(src).toContain("import { TERMS_VERSION } from '@/lib/auth/terms'")
    expect(src).toContain('&terms=${encodeURIComponent(TERMS_VERSION)}')
    expect(src).toContain('By continuing with Google you agree to our')
  })

  it('M1: factors DELETE verifies the factor is one of the caller\'s verified factors before unenrolling', () => {
    const src = read('app/api/auth/mfa/factors/route.ts')
    const del = src.slice(src.indexOf('export async function DELETE'))
    const check = del.indexOf('factorList?.totp')
    const unenroll = del.indexOf('supabase.auth.mfa.unenroll')
    expect(check).toBeGreaterThan(-1)
    expect(unenroll).toBeGreaterThan(check)
  })

  it('M2: handleVerify catches a non-JSON body; mfa-challenge never replaces itself with itself', () => {
    const client = read('components/mfa/MfaSetupClient.tsx')
    const fn = client.slice(client.indexOf('async function handleVerify'), client.indexOf('async function handleGenerateCodes'))
    expect(fn).toContain('await res.json().catch(')
    expect(read('app/mfa-challenge/page.tsx')).toContain("next.startsWith('/mfa-challenge') ? '/dashboard' : next")
  })
})
