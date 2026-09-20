// lib/auth/attempt-limit.ts
//
// FIX (build — Auth independent audit, feature gap): the app added no throttle
// of its own to /api/auth/mfa/verify, /api/auth/mfa/recover or the
// current-password check in /api/auth/change-password. The only protection was
// whatever GoTrue rate-limits by IP — and those calls are made from the
// server, so the limiter sees the hosting provider's egress IPs, not the
// attacker's (and can trip for everyone at once). This is a per-USER failure
// ledger (public.auth_attempts, migration 064): N failures inside the window
// locks that kind of attempt for the account until the oldest of them ages out.
//
// Fails OPEN on a ledger error (logged): GoTrue's own limits still apply, and
// a database hiccup must not lock everybody out of signing in.

export type AuthAttemptKind = 'mfa_verify' | 'mfa_recover' | 'password_verify'

export const AUTH_ATTEMPT_LIMIT = { maxFailures: 5, windowSeconds: 300 } as const

export interface AttemptCheck {
  allowed: boolean
  retryAfterSeconds: number
  failures: number
}

export async function checkAuthAttemptLimit(
  service: any,
  userId: string,
  kind: AuthAttemptKind,
  now: number = Date.now()
): Promise<AttemptCheck> {
  const { maxFailures, windowSeconds } = AUTH_ATTEMPT_LIMIT
  try {
    const since = new Date(now - windowSeconds * 1000).toISOString()
    const { data, error } = await service
      .from('auth_attempts')
      .select('created_at')
      .eq('user_id', userId)
      .eq('kind', kind)
      .eq('succeeded', false)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(maxFailures)
    if (error) throw new Error(error.message)
    const rows: Array<{ created_at: string }> = data || []
    if (rows.length < maxFailures) {
      return { allowed: true, retryAfterSeconds: 0, failures: rows.length }
    }
    // Locked until the OLDEST of the last `maxFailures` failures leaves the window.
    const oldest = new Date(rows[rows.length - 1].created_at).getTime()
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - now) / 1000))
    return { allowed: false, retryAfterSeconds, failures: rows.length }
  } catch (err) {
    console.error('checkAuthAttemptLimit failed (failing open):', err)
    return { allowed: true, retryAfterSeconds: 0, failures: 0 }
  }
}

export async function recordAuthFailure(service: any, userId: string, kind: AuthAttemptKind): Promise<void> {
  try {
    const { error } = await service.from('auth_attempts').insert({ user_id: userId, kind, succeeded: false })
    if (error) console.error('recordAuthFailure insert failed:', error.message)
  } catch (err) {
    console.error('recordAuthFailure failed:', err)
  }
}

/** A success wipes the failure history for that kind (a normal typo isn't a strike forever). */
export async function clearAuthFailures(service: any, userId: string, kind: AuthAttemptKind): Promise<void> {
  try {
    const { error } = await service
      .from('auth_attempts').delete().eq('user_id', userId).eq('kind', kind).eq('succeeded', false)
    if (error) console.error('clearAuthFailures failed:', error.message)
  } catch (err) {
    console.error('clearAuthFailures failed:', err)
  }
}

export function lockoutMessage(retryAfterSeconds: number): string {
  const mins = Math.ceil(retryAfterSeconds / 60)
  return `Too many incorrect attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
}
