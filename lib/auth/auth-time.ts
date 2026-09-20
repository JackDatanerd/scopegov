// lib/auth/auth-time.ts
//
// FIX (build — Auth independent audit, MEDIUM): "how recently did this person
// actually authenticate?" was answered with the access token's `iat` claim in
// /api/auth/change-password (first-password rule) and /api/auth/login-event.
// `iat` is when the ACCESS TOKEN was minted, and Supabase re-mints it on every
// refresh (about hourly, and on any request that lands near expiry). So:
//   - a stolen cookie replayed hours later got a fresh `iat` from its very
//     first request and passed the "recent sign-in" check, and
//   - a legitimate user whose token was 16-60 minutes into its life was
//     rejected even if they had signed in moments ago.
// The JWT's `amr` claim records each authentication METHOD with the time it
// happened, and that timestamp survives refreshes. Refreshes themselves add a
// `token_refresh` entry, which must be ignored or we're back to token age.

export interface JwtPayload {
  iat?: number
  aal?: string
  amr?: Array<{ method?: string; timestamp?: number }>
  [key: string]: unknown
}

export function decodeJwtPayload(token: string | null | undefined): JwtPayload | null {
  if (!token) return null
  const part = token.split('.')[1]
  if (!part) return null
  try {
    // base64url -> base64 (Buffer tolerates the missing padding)
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JwtPayload) : null
  } catch {
    return null
  }
}

/**
 * Unix seconds of the most recent real authentication event (password, OTP,
 * OAuth, TOTP challenge...). Falls back to `iat` only when the token carries no
 * usable `amr` at all (an old GoTrue) — weaker, but the only signal there is.
 */
export function lastAuthenticatedAtSeconds(payload: JwtPayload | null): number | null {
  if (!payload) return null
  let best: number | null = null
  if (Array.isArray(payload.amr)) {
    for (const entry of payload.amr) {
      if (!entry || typeof entry !== 'object') continue
      if (entry.method === 'token_refresh') continue
      if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) {
        best = best === null ? entry.timestamp : Math.max(best, entry.timestamp)
      }
    }
  }
  if (best !== null) return best
  return typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : null
}

/** Seconds since the last real authentication, or null when it can't be told. */
export function authenticationAgeSeconds(
  payload: JwtPayload | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): number | null {
  const at = lastAuthenticatedAtSeconds(payload)
  return at === null ? null : nowSeconds - at
}

export type LoginMethod = 'password' | 'google' | 'email_confirmation'

/** Which sign-in method the session was established with, for the audit trail. */
export function loginMethodFromAmr(payload: JwtPayload | null): LoginMethod {
  const methods = new Set(
    (Array.isArray(payload?.amr) ? payload!.amr! : [])
      .map(e => (e && typeof e === 'object' ? e.method : undefined))
      .filter((m): m is string => typeof m === 'string')
  )
  if (methods.has('oauth')) return 'google'
  if (methods.has('password')) return 'password'
  for (const m of ['otp', 'email/signup', 'magiclink', 'recovery', 'invite', 'email_change']) {
    if (methods.has(m)) return 'email_confirmation'
  }
  return 'password'
}
