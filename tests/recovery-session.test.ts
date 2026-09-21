import { describe, it, expect } from 'vitest'
import { isMailboxProvenSession, latestPrimaryAuthMethod, lastTotpAtSeconds } from '@/lib/auth/auth-time'

const now = 1_800_000_000
const payload = (amr: Array<{ method: string; timestamp: number }>) => ({ iat: now, amr })

describe('isMailboxProvenSession (who may use /api/auth/reset-password)', () => {
  it('rejects an ordinary password sign-in — the bypass this closes', () => {
    expect(isMailboxProvenSession(payload([{ method: 'password', timestamp: now - 60 }]))).toBe(false)
  })
  it('rejects OAuth and SSO sign-ins', () => {
    expect(isMailboxProvenSession(payload([{ method: 'oauth', timestamp: now - 60 }]))).toBe(false)
    expect(isMailboxProvenSession(payload([{ method: 'sso/saml', timestamp: now - 60 }]))).toBe(false)
  })
  it('accepts recovery / OTP / magic-link sessions', () => {
    for (const method of ['recovery', 'otp', 'magiclink']) {
      expect(isMailboxProvenSession(payload([{ method, timestamp: now - 60 }]))).toBe(true)
    }
  })
  it('ignores token refreshes and the TOTP step when judging the primary method', () => {
    expect(isMailboxProvenSession(payload([
      { method: 'recovery', timestamp: now - 300 }, { method: 'totp', timestamp: now - 200 }, { method: 'token_refresh', timestamp: now - 10 },
    ]))).toBe(true)
    expect(isMailboxProvenSession(payload([
      { method: 'password', timestamp: now - 300 }, { method: 'totp', timestamp: now - 200 }, { method: 'token_refresh', timestamp: now - 10 },
    ]))).toBe(false)
  })
  it('a password sign-in AFTER a recovery link makes the session a password session', () => {
    expect(isMailboxProvenSession(payload([{ method: 'recovery', timestamp: now - 600 }, { method: 'password', timestamp: now - 30 }]))).toBe(false)
  })
  it('fails closed on a missing / malformed token', () => {
    expect(isMailboxProvenSession(null)).toBe(false)
    expect(isMailboxProvenSession({ iat: now } as any)).toBe(false)
    expect(isMailboxProvenSession({ amr: [null, 'x', { method: 5 }] } as any)).toBe(false)
  })
})

describe('latestPrimaryAuthMethod / lastTotpAtSeconds', () => {
  it('picks the newest non-refresh, non-totp entry', () => {
    expect(latestPrimaryAuthMethod(payload([{ method: 'password', timestamp: 1 }, { method: 'otp', timestamp: 5 }]))).toEqual({ method: 'otp', timestamp: 5 })
  })
  it('finds the newest totp step, or null', () => {
    expect(lastTotpAtSeconds(payload([{ method: 'totp', timestamp: 4 }, { method: 'totp', timestamp: 9 }]))).toBe(9)
    expect(lastTotpAtSeconds(payload([{ method: 'password', timestamp: 4 }]))).toBeNull()
  })
})
