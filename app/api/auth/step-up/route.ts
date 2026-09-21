export const runtime = 'nodejs'

// POST /api/auth/step-up — prove it's really the account holder before a
// sensitive action (see lib/auth/step-up.ts for the list and the rules).
//
//   { method: 'totp',     factorId, code }   accounts with a second factor
//   { method: 'password', password }          password accounts without one
//
// Success records a grant bound to THIS session for STEP_UP_WINDOW_SECONDS. Both
// checks run through the same atomic attempt ledger as sign-in (5 failures / 5 min).

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceClient, createStatelessAuthClient } from '@/lib/supabase/server'
import { beginAuthAttempt, releaseAuthAttempt, clearAuthFailures, lockedResponseBody } from '@/lib/auth/attempt-limit'
import { loadStepUpContext, recordStepUpGrant, STEP_UP_WINDOW_SECONDS } from '@/lib/auth/step-up'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null) as
      { method?: unknown; factorId?: unknown; code?: unknown; password?: unknown } | null
    const method = body?.method
    if (method !== 'totp' && method !== 'password') {
      return NextResponse.json({ error: 'Unknown verification method' }, { status: 400 })
    }

    const service = createServiceClient() as any
    const ctx = await loadStepUpContext(supabase, user)

    // An account with a second factor confirms with a code, never just a password.
    if (ctx.mfaEnrolled && method !== 'totp') {
      return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.', code: 'totp_required' }, { status: 400 })
    }

    if (method === 'totp') {
      if (typeof body?.factorId !== 'string' || typeof body?.code !== 'string') {
        return NextResponse.json({ error: 'factorId and code are required' }, { status: 400 })
      }
      const code = body.code.replace(/\s+/g, '')
      if (!/^\d{6}$/.test(code)) {
        return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.' }, { status: 400 })
      }
      const begin = await beginAuthAttempt(service, user.id, 'mfa_verify')
      if (!begin.allowed) {
        return NextResponse.json(lockedResponseBody(begin), { status: 429, headers: { 'Retry-After': String(begin.retryAfterSeconds) } })
      }
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: body.factorId, code })
      if (error) {
        const errCode = (error as any).code as string | undefined
        const msg = String((error as any).message || '')
        const wrong = errCode === 'mfa_verification_failed' || /invalid totp|incorrect|verification failed/i.test(msg)
        if (!wrong) {
          await releaseAuthAttempt(service, begin.attemptId)
          const locked = errCode === 'mfa_verification_rejected' || /too many incorrect attempts/i.test(msg)
          return NextResponse.json(
            { error: locked ? msg : 'We couldn\u2019t verify that code right now. Please try again.', code: locked ? 'locked' : 'verify_unavailable' },
            { status: locked ? 429 : 502 }
          )
        }
        return NextResponse.json({ error: 'Incorrect code. Check your authenticator app and try again.', code: 'incorrect_code' }, { status: 400 })
      }
      await clearAuthFailures(service, user.id, 'mfa_verify')
    } else {
      if (typeof body?.password !== 'string' || !body.password) {
        return NextResponse.json({ error: 'Password is required' }, { status: 400 })
      }
      const begin = await beginAuthAttempt(service, user.id, 'password_verify')
      if (!begin.allowed) {
        return NextResponse.json(lockedResponseBody(begin), { status: 429, headers: { 'Retry-After': String(begin.retryAfterSeconds) } })
      }
      const verifyClient = createStatelessAuthClient()
      const { data, error } = await verifyClient.auth.signInWithPassword({ email: user.email!, password: body.password })
      if (error) {
        const wrong = (error as any).code === 'invalid_credentials' || /invalid login credentials/i.test(String((error as any).message || ''))
        if (!wrong) {
          await releaseAuthAttempt(service, begin.attemptId)
          return NextResponse.json({ error: 'We couldn\u2019t verify your password right now. Please try again.', code: 'verify_unavailable' }, { status: 502 })
        }
        return NextResponse.json({ error: 'Incorrect password.', code: 'incorrect_password' }, { status: 400 })
      }
      await clearAuthFailures(service, user.id, 'password_verify')
      if (data?.session) await verifyClient.auth.signOut({ scope: 'local' }).catch(() => {})
    }

    // TOTP verification refreshed the session cookies (new session_id claim is the
    // same, amr gained a fresh `totp` entry) — re-read the context for the key.
    const fresh = await loadStepUpContext(supabase, user)
    const ok = await recordStepUpGrant(service, user.id, fresh.sessionKey, method)
    if (!ok) return NextResponse.json({ error: 'Could not record the confirmation. Please try again.' }, { status: 500 })

    return NextResponse.json({ ok: true, expiresInSeconds: STEP_UP_WINDOW_SECONDS })
  } catch (err) {
    console.error('Step-up error:', err)
    return NextResponse.json({ error: 'Could not verify' }, { status: 500 })
  }
}
