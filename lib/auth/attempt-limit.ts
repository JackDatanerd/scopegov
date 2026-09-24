// lib/auth/attempt-limit.ts
//
// Per-USER failure ledger (public.auth_attempts) for the credential checks the
// app runs itself: /api/auth/mfa/verify, /api/auth/mfa/recover, the current-
// password check in /api/auth/change-password and /api/auth/step-up.
//
// ATOMIC (migration 068): the old limiter read the ledger, ran the check, then
// wrote the failure — so a burst of parallel guesses all passed the read before
// any failure landed. beginAuthAttempt() now RESERVES a slot inside one SQL
// function (advisory lock + insert + count) BEFORE the credential is checked. A
// reservation counts as a failure until it is released (the error wasn't the
// person's typo) or cleared (success). However many requests arrive at once, at
// most `maxFailures` of them ever reach the credential check per window.
//
// This ledger only protects calls that go through the app. Direct calls to
// GoTrue are covered only by the Auth hooks created in migration 068 — which the Supabase
// Team/Enterprise plan is needed to enable (README §1.3). On a lower plan that path is open.
//
// Fails OPEN on a ledger error (logged): GoTrue's own limits still apply, and a
// database hiccup must not lock everybody out of signing in.

export type AuthAttemptKind = 'mfa_verify' | 'mfa_recover' | 'password_verify'

export const AUTH_ATTEMPT_LIMIT = { maxFailures: 5, windowSeconds: 300 } as const

export interface AttemptBegin {
  allowed: boolean
  retryAfterSeconds: number
  /** Failures in the window INCLUDING this reservation (when allowed). */
  failures: number
  /** Pass to releaseAuthAttempt() when the failure wasn't the person's fault. */
  attemptId: string | null
}

export async function beginAuthAttempt(
  service: any,
  userId: string,
  kind: AuthAttemptKind
): Promise<AttemptBegin> {
  const { maxFailures, windowSeconds } = AUTH_ATTEMPT_LIMIT
  try {
    const { data, error } = await service.rpc('auth_attempt_begin', {
      p_user: userId, p_kind: kind, p_max: maxFailures, p_window_seconds: windowSeconds,
    })
    if (error) throw new Error(error.message)
    const r = (data || {}) as { allowed?: boolean; attempt_id?: string | null; failures?: number; retry_after_seconds?: number }
    return {
      allowed: r.allowed !== false,
      retryAfterSeconds: Math.max(0, Number(r.retry_after_seconds) || 0),
      failures: Number(r.failures) || 0,
      attemptId: r.attempt_id ?? null,
    }
  } catch (err) {
    console.error('beginAuthAttempt failed (failing open):', err)
    return { allowed: true, retryAfterSeconds: 0, failures: 0, attemptId: null }
  }
}

/** The reserved attempt turned out not to be a wrong guess (rate limit, expired challenge, network). */
export async function releaseAuthAttempt(service: any, attemptId: string | null): Promise<void> {
  if (!attemptId) return
  try {
    const { error } = await service.rpc('auth_attempt_release', { p_attempt: attemptId })
    if (error) console.error('releaseAuthAttempt failed:', error.message)
  } catch (err) {
    console.error('releaseAuthAttempt failed:', err)
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
  const mins = Math.max(1, Math.ceil(retryAfterSeconds / 60))
  return `Too many incorrect attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
}

/** Standard 429 body for a locked attempt. */
export function lockedResponseBody(begin: AttemptBegin) {
  return { error: lockoutMessage(begin.retryAfterSeconds), code: 'locked', retryAfterSeconds: begin.retryAfterSeconds }
}
