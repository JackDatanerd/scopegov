// lib/auth/password-policy.ts
//
// Server-side password rules shared by every route that accepts a NEW password
// (change-password, reset-password, the invite-signup route).
//
//  - min length 8 (matches the client forms);
//  - max 72 BYTES: bcrypt (which GoTrue uses) truncates at 72 bytes, so a longer
//    password would be silently accepted but only its first 72 bytes checked —
//    and GoTrue itself rejects it with a confusing error;
//  - (audit round 2) not a single repeated character, not on the short list of
//    passwords that dominate every breach corpus, and not the person's own email.
//    This is a cheap floor, not a substitute for Supabase's "Leaked password
//    protection" (HaveIBeenPwned) setting, which README §1.3 asks you to enable.

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_BYTES = 72

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '123123123', '11111111', '00000000', '87654321', '12341234',
  'qwertyui', 'qwerty123', 'qwertyuiop', 'qwerty12', '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'asdfghjk', 'asdf1234',
  'iloveyou', 'letmein1', 'welcome1', 'welcome123', 'admin123', 'administrator', 'changeme', 'changeme123',
  'abc12345', 'abcd1234', 'abcdefgh', 'monkey123', 'dragon123', 'football1', 'baseball1', 'superman1',
  'trustno1', 'sunshine1', 'princess1', 'starwars1', 'whatever1', 'scopegov', 'scopegov1', 'scopegov123',
])

export function validatePassword(password: unknown, context?: { email?: string | null }): string | null {
  if (typeof password !== 'string') return 'Password is required'
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return `Password must be at most ${PASSWORD_MAX_BYTES} bytes`

  const lowered = password.toLowerCase()
  if (new Set(lowered).size <= 1) return 'Choose a password that isn\u2019t just one repeated character.'
  if (COMMON_PASSWORDS.has(lowered)) return 'That password is too common. Choose something harder to guess.'

  const email = (context?.email || '').trim().toLowerCase()
  if (email) {
    const local = email.split('@')[0]
    if (lowered === email || (local.length >= 6 && lowered === local)) {
      return 'Your password can\u2019t be your email address.'
    }
  }
  return null
}
