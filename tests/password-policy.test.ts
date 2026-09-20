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
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull()
  })
  it('enforces the bcrypt 72-BYTE limit (not 72 characters)', () => {
    expect(validatePassword('a'.repeat(PASSWORD_MAX_BYTES))).toBeNull()
    expect(validatePassword('a'.repeat(PASSWORD_MAX_BYTES + 1))).not.toBeNull()
    // 30 four-byte characters = 120 bytes, well under 72 *characters*
    expect(validatePassword('\u{1F511}'.repeat(30))).not.toBeNull()
  })
})
