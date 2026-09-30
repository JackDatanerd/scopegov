// tests/auth-mfa-independent-pass-6.test.ts
//
// Regression tests for the Auth + MFA independent pass, round 6.
//   B1  The pass-5 fixes must live at the REAL paths (a wrongly-extracted delivery left them in stray
//       root-level copies); no stray copies may remain.
//   B6  middleware matcher must not gate the public PWA/tile metadata files layout.tsx links to.
//   B7  reset-password page treats a code-less 401 (middleware's bare Unauthorized) as an invalid link.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

function matcherRegex(): RegExp {
  const src = read('middleware.ts')
  const m = src.match(/matcher:\s*\[\s*(?:\/\*[\s\S]*?\*\/\s*)?'([^']+)'/)
  expect(m).toBeTruthy()
  // Next anchors the matcher as a full-path regex; the JS string escapes \\ -> \
  return new RegExp('^' + m![1].replace(/\\\\/g, '\\') + '$')
}

describe('Auth+MFA pass 6', () => {
  it('B1: no stray root-level copies of app files remain', () => {
    for (const p of [
      '(auth)', '(app)', 'api', 'mfa', 'mfa-challenge', 'auth-mfa-independent-pass-5.test.ts',
    ]) expect(existsSync(join(process.cwd(), p)), p).toBe(false)
  })

  it('B1: the pass-5 fixes are present at the real paths', () => {
    expect(read('app/(app)/settings/page.tsx')).toContain("rpc('user_has_password', { p_user: session.id })")
    expect(read('app/(auth)/login/LoginForm.tsx')).toContain('&terms=${encodeURIComponent(TERMS_VERSION)}')
    expect(read('app/api/auth/mfa/factors/route.ts')).toContain('factorList?.totp')
    expect(read('components/mfa/MfaSetupClient.tsx')).toContain('await res.json().catch(')
    expect(read('app/mfa-challenge/page.tsx')).toContain("next.startsWith('/mfa-challenge') ? '/dashboard' : next")
  })

  it('B6: matcher excludes /site.webmanifest and /browserconfig.xml but still gates app pages and APIs', () => {
    const re = matcherRegex()
    expect(re.test('/site.webmanifest')).toBe(false)
    expect(re.test('/browserconfig.xml')).toBe(false)
    expect(re.test('/favicon.ico')).toBe(false)
    expect(re.test('/logo.png')).toBe(false)
    expect(re.test('/dashboard')).toBe(true)
    expect(re.test('/login')).toBe(true)
    expect(re.test('/api/auth/signup')).toBe(true)
    expect(re.test('/some/dir/browserconfig.xml')).toBe(true)
  })

  it('B7: reset-password page shows the expired-link screen for a code-less 401', () => {
    const src = read('app/(auth)/reset-password/page.tsx')
    expect(src).toContain("(res.status === 401 && !body.code)")
  })
})
