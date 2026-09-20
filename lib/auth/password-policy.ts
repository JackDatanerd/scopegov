// lib/auth/password-policy.ts
//
// One server-side password rule for the routes this app controls
// (/api/auth/change-password, /api/auth/reset-password). The client forms show
// the same minimum, but a client check is only a courtesy. NOTE: sign-up talks
// to Supabase Auth directly from the browser, so the server-enforced minimum
// there is whatever the Supabase dashboard is set to — see README §1.3.

export const PASSWORD_MIN_LENGTH = 8
// bcrypt (which GoTrue uses) only hashes the first 72 BYTES; GoTrue rejects longer input.
export const PASSWORD_MAX_BYTES = 72

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required'
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return `Password must be at most ${PASSWORD_MAX_BYTES} bytes`
  return null
}
