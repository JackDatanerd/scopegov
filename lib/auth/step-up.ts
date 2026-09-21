// lib/auth/step-up.ts
//
// "Confirm it's you" for the account-level actions where a stolen or idle
// session must not be enough on its own: turning MFA off, regenerating backup
// codes, deleting the account or workspace, transferring ownership, resetting a
// teammate's MFA, cancelling billing, changing the sign-in email.
//
// Until now these checked only that the session was at aal2 — which persists for
// the whole life of the session — or (account deletion) that the caller could
// TYPE their own email, which proves nothing.
//
// A step-up is satisfied when, within the last STEP_UP_WINDOW_SECONDS:
//   - the person signed in (password / OAuth / recovery) AND has no second factor, or
//   - the person completed a TOTP challenge (second-factor accounts), or
//   - they passed POST /api/auth/step-up (password or TOTP), which records a grant
//     bound to THIS session in public.step_up_grants (migration 066).

import { NextResponse } from 'next/server'
import { decodeJwtPayload, authenticationAgeSeconds, lastTotpAtSeconds, type JwtPayload } from '@/lib/auth/auth-time'

export const STEP_UP_WINDOW_SECONDS = 600

export type StepUpMethod = 'password' | 'totp'

export interface StepUpContext {
  payload: JwtPayload | null
  sessionKey: string
  mfaEnrolled: boolean
}

export function stepUpSessionKey(payload: JwtPayload | null, userId: string): string {
  return payload?.session_id ? String(payload.session_id) : `nosession:${userId}`
}

export async function loadStepUpContext(supabase: any, user: any): Promise<StepUpContext> {
  const { data: { session } } = await supabase.auth.getSession()
  const payload = decodeJwtPayload(session?.access_token)
  const mfaEnrolled = ((user?.factors as Array<{ status: string }> | undefined) || []).some(f => f.status === 'verified')
  return { payload, sessionKey: stepUpSessionKey(payload, user.id), mfaEnrolled }
}

/** Pure part of the decision, exported for tests. */
export function isFreshlyAuthenticated(
  payload: JwtPayload | null, mfaEnrolled: boolean, nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (mfaEnrolled) {
    const totpAt = lastTotpAtSeconds(payload)
    return totpAt !== null && nowSeconds - totpAt <= STEP_UP_WINDOW_SECONDS
  }
  const age = authenticationAgeSeconds(payload, nowSeconds)
  return age !== null && age <= STEP_UP_WINDOW_SECONDS
}

export async function hasStepUpGrant(service: any, userId: string, sessionKey: string): Promise<boolean> {
  try {
    const { data } = await service
      .from('step_up_grants').select('id')
      .eq('user_id', userId).eq('session_id', sessionKey)
      .gt('expires_at', new Date().toISOString()).limit(1)
    return !!(data && data.length)
  } catch (err) {
    console.error('hasStepUpGrant failed (treating as not satisfied):', err)
    return false
  }
}

export async function recordStepUpGrant(service: any, userId: string, sessionKey: string, method: StepUpMethod): Promise<boolean> {
  const { error } = await service.from('step_up_grants').insert({
    user_id: userId, session_id: sessionKey, method,
    expires_at: new Date(Date.now() + STEP_UP_WINDOW_SECONDS * 1000).toISOString(),
  })
  if (error) console.error('recordStepUpGrant failed:', error.message)
  return !error
}

/**
 * Returns null when the caller may proceed, otherwise the 401 response to send.
 * Body: { error, code: 'step_up_required', methods: ['totp'] | ['password'] | [] }.
 * An empty `methods` (a passwordless OAuth account whose sign-in is stale) tells
 * the client to ask for a fresh sign-in instead.
 */
export async function requireStepUp(supabase: any, service: any, user: any): Promise<NextResponse | null> {
  const ctx = await loadStepUpContext(supabase, user)
  if (isFreshlyAuthenticated(ctx.payload, ctx.mfaEnrolled)) return null
  if (await hasStepUpGrant(service, user.id, ctx.sessionKey)) return null

  let methods: StepUpMethod[] = []
  if (ctx.mfaEnrolled) {
    methods = ['totp']
  } else {
    const { data: hasPw } = await service.rpc('user_has_password', { p_user: user.id })
    if (hasPw === true) methods = ['password']
  }
  return NextResponse.json({
    error: methods.length
      ? 'Please confirm it\u2019s you to continue.'
      : 'For your security, sign out and sign back in, then try again.',
    code: 'step_up_required',
    methods,
  }, { status: 401 })
}

/** For routes that authenticate through getSession() (workspace-scoped) rather than holding a supabase client. */
export async function requireStepUpForCurrentUser(): Promise<NextResponse | null> {
  const { createServerSupabaseClient, createServiceClient } = await import('@/lib/supabase/server')
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return requireStepUp(supabase, createServiceClient() as any, user)
}
