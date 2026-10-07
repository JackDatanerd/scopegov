import { describe, it, expect, afterEach } from 'vitest'
import { mfaIsEnforced } from '@/lib/auth/mfa-policy'

describe('MFA enforcement mode', () => {
  const prev = process.env.MFA_ENFORCEMENT
  afterEach(() => { if (prev === undefined) delete process.env.MFA_ENFORCEMENT; else process.env.MFA_ENFORCEMENT = prev })

  it('defaults to recommended (not enforced)', () => {
    delete process.env.MFA_ENFORCEMENT
    expect(mfaIsEnforced()).toBe(false)
  })
  it('only the exact value "required" re-enables the hard gate', () => {
    process.env.MFA_ENFORCEMENT = 'required'
    expect(mfaIsEnforced()).toBe(true)
    process.env.MFA_ENFORCEMENT = 'true'
    expect(mfaIsEnforced()).toBe(false)
  })
})
