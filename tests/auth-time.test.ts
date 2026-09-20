import { describe, it, expect } from 'vitest'
import {
  decodeJwtPayload, lastAuthenticatedAtSeconds, authenticationAgeSeconds, loginMethodFromAmr,
} from '@/lib/auth/auth-time'

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`
}

describe('decodeJwtPayload', () => {
  it('decodes base64url payloads with no padding', () => {
    expect(decodeJwtPayload(jwt({ iat: 1, aal: 'aal1' }))).toEqual({ iat: 1, aal: 'aal1' })
  })
  it('returns null for garbage instead of throwing', () => {
    expect(decodeJwtPayload(undefined)).toBeNull()
    expect(decodeJwtPayload('')).toBeNull()
    expect(decodeJwtPayload('abc')).toBeNull()
    expect(decodeJwtPayload('a.!!!.c')).toBeNull()
    expect(decodeJwtPayload(`a.${Buffer.from('[1,2]').toString('base64')}.c`)).toBeNull()
  })
})

// The bug: "recent sign-in" used `iat`, which Supabase resets on every token
// refresh. amr[].timestamp records the real authentication and survives refreshes.
describe('lastAuthenticatedAtSeconds', () => {
  it('uses the amr authentication time, NOT the (refreshed) iat', () => {
    const now = 1_800_000_000
    const p = decodeJwtPayload(jwt({
      iat: now - 30,                                      // token refreshed 30s ago
      amr: [{ method: 'password', timestamp: now - 86_400 }, { method: 'token_refresh', timestamp: now - 30 }],
    }))
    expect(lastAuthenticatedAtSeconds(p)).toBe(now - 86_400)
    expect(authenticationAgeSeconds(p, now)).toBe(86_400) // a day old => fails a 15-minute freshness rule
  })

  it('takes the most recent real authentication (e.g. the TOTP step)', () => {
    const p = decodeJwtPayload(jwt({ amr: [{ method: 'password', timestamp: 100 }, { method: 'totp', timestamp: 160 }] }))
    expect(lastAuthenticatedAtSeconds(p)).toBe(160)
  })

  it('ignores token_refresh entries entirely', () => {
    const p = decodeJwtPayload(jwt({ iat: 500, amr: [{ method: 'token_refresh', timestamp: 500 }] }))
    // no real authentication event -> falls back to iat (weaker signal, documented)
    expect(lastAuthenticatedAtSeconds(p)).toBe(500)
  })

  it('falls back to iat only when amr is absent, and to null when nothing is usable', () => {
    expect(lastAuthenticatedAtSeconds(decodeJwtPayload(jwt({ iat: 42 })))).toBe(42)
    expect(lastAuthenticatedAtSeconds(decodeJwtPayload(jwt({})))).toBeNull()
    expect(lastAuthenticatedAtSeconds(null)).toBeNull()
    expect(authenticationAgeSeconds(null)).toBeNull()
  })

  it('skips malformed amr entries', () => {
    const p = decodeJwtPayload(jwt({ amr: [null, 5, { method: 'password' }, { method: 'password', timestamp: 'x' }, { method: 'otp', timestamp: 9 }] }))
    expect(lastAuthenticatedAtSeconds(p)).toBe(9)
  })
})

describe('loginMethodFromAmr', () => {
  it('maps amr methods to the audit-trail label', () => {
    expect(loginMethodFromAmr(decodeJwtPayload(jwt({ amr: [{ method: 'oauth', timestamp: 1 }] })))).toBe('google')
    expect(loginMethodFromAmr(decodeJwtPayload(jwt({ amr: [{ method: 'password', timestamp: 1 }, { method: 'totp', timestamp: 2 }] })))).toBe('password')
    expect(loginMethodFromAmr(decodeJwtPayload(jwt({ amr: [{ method: 'otp', timestamp: 1 }] })))).toBe('email_confirmation')
    expect(loginMethodFromAmr(null)).toBe('password')
  })
})
