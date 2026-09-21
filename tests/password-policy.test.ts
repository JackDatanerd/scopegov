import { describe, it, expect } from 'vitest'
import { validatePassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES } from '@/lib/auth/password-policy'

describe('validatePassword', () => {
  it('accepts a normal password', () => {
    expect(validatePassword('correct horse battery')).toBeNull()
  })
  it('rejects non-strings and short passwords', () => {
    expect(validatePassword(undefined)).not.toBeNull()
    expect(validatePassword(12345678)).not.toBeNull()
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).not.toBeNull()
    expect(validatePassword('ab'.repeat(PASSWORD_MIN_LENGTH / 2))).toBeNull()
  })
  it('enforces the bcrypt 72-BYTE limit (not 72 characters)', () => {
    expect(validatePassword('ab'.repeat(PASSWORD_MAX_BYTES / 2))).toBeNull()
    expect(validatePassword('a'.repeat(PASSWORD_MAX_BYTES + 1))).not.toBeNull()
    // 30 four-byte characters = 120 bytes, well under 72 *characters*
    expect(validatePassword('\u{1F511}'.repeat(30))).not.toBeNull()
  })
  it('rejects a single repeated character, common passwords, and the account email', () => {
    expect(validatePassword('aaaaaaaa')).not.toBeNull()
    expect(validatePassword('Password123')).not.toBeNull()
    expect(validatePassword('12345678')).not.toBeNull()
    expect(validatePassword('jane.doe@agency.com', { email: 'jane.doe@agency.com' })).not.toBeNull()
    expect(validatePassword('jane.doe', { email: 'jane.doe@agency.com' })).not.toBeNull()
    expect(validatePassword('jane.doe-2026-x', { email: 'jane.doe@agency.com' })).toBeNull()
  })
})
