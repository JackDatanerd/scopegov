export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { notifySecurityEvent } from '@/lib/utils/notify'
import { issueBackupCodes } from '@/lib/auth/backup-code-store'
import { sendMfaEnabledEmail } from '@/lib/email/templates'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'
import { decodeJwtPayload, loginMethodFromAmr } from '@/lib/auth/auth-time'
import {
  checkAuthAttemptLimit, recordAuthFailure, clearAuthFailures, lockoutMessage, AUTH_ATTEMPT_LIMIT,
} from '@/lib/auth/attempt-limit'

// POST /api/auth/mfa/verify — two callers share this endpoint:
//   1. FIRST ENROLMENT: the factor being verified is still `unverified`. On
//      success we issue backup codes (returned once), audit + notify + email,
//      and revoke every other session.
//   2. LOGIN CHALLENGE: the factor is already `verified`. On success the
//      session becomes aal2 and the sign-in is recorded in the audit trail.
//
// FIX (build — Auth independent audit, MEDIUM): "is this the first enrolment?"
// used to be inferred from "the user has zero unused backup codes". That
// conflates "never enrolled" with "used every code": such a user got a brand
// new, never-displayed code set plus a false `mfa_enabled` audit row, email and
// notification on an ordinary login. The header comment's claim that the DB
// check made the endpoint "safe to retry" was also wrong — a retry after a lost
// response finds the codes already stored and returns none (the same hidden-
// codes failure it was meant to fix). Enrolment is now decided by the factor's
// OWN status before verification, which is exactly the thing that changes on
// success; a retry is treated as a normal challenge and the setup screen offers
// to regenerate codes when none came back.
//
// Other fixes here: every upstream failure used to be reported as "Incorrect
// code" (rate limits, expired challenge, network) which invites retries into a
// rate limit; `code` wasn't type-checked (a numeric code threw a 500); there was
// no throttle and failed challenges left no audit trail.

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null) as { factorId?: unknown; code?: unknown } | null
    if (typeof body?.factorId !== 'string' || !body.factorId || typeof body?.code !== 'string') {
      return NextResponse.json({ error: 'factorId and code are required' }, { status: 400 })
    }
    const factorId = body.factorId
    // Authenticator apps often display the code as "123 456".
    const code = body.code.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.' }, { status: 400 })
    }

    const service = createServiceClient()

    const limit = await checkAuthAttemptLimit(service, user.id, 'mfa_verify')
    if (!limit.allowed) {
      return NextResponse.json(
        { error: lockoutMessage(limit.retryAfterSeconds), code: 'locked', retryAfterSeconds: limit.retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
      )
    }

    // Live factor list (from Supabase Auth, not a cookie cache).
    const { data: factorList } = await supabase.auth.mfa.listFactors()
    const factor = (factorList?.all || []).find(f => f.id === factorId)
    if (!factor) {
      return NextResponse.json({
        error: 'That authenticator is no longer registered on this account. Refresh the page and try again.',
        code: 'factor_not_found',
      }, { status: 400 })
    }
    const isEnrolment = factor.status !== 'verified'

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
    if (error) {
      const status = (error as any).status as number | undefined
      const errCode = (error as any).code as string | undefined
      const message = String((error as any).message || '')

      if (status === 429 || errCode === 'over_request_rate_limit') {
        return NextResponse.json(
          { error: 'Too many attempts right now. Wait a minute and try again.', code: 'rate_limited' },
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      }

      const wrongCode = errCode === 'mfa_verification_failed' || /invalid totp|incorrect|verification failed/i.test(message)
      if (!wrongCode) {
        // Expired challenge, factor gone, network trouble: not the user's typo, so
        // it isn't a strike and shouldn't be reported as one.
        console.error('MFA challengeAndVerify failed:', errCode, message)
        return NextResponse.json({ error: 'We couldn\u2019t verify that code right now. Please try again.', code: 'verify_unavailable' }, { status: 502 })
      }

      await recordAuthFailure(service, user.id, 'mfa_verify')
      if (!isEnrolment) {
        // A failed login challenge is a security-relevant event; a typo while
        // setting up an authenticator is not. Bounded: the limiter stops us
        // after AUTH_ATTEMPT_LIMIT.maxFailures rows per window.
        const after = await checkAuthAttemptLimit(service, user.id, 'mfa_verify')
        try {
          await logAudit(service, {
            workspaceId: (await resolveActiveWorkspaceId(service, user.id)) || '',
            actorId: user.id, actorEmail: user.email!,
            actorName: await resolveActorName(service, user.id, user.user_metadata?.name || user.email!),
            eventType: 'security.mfa_challenge_failed', entityType: 'user', entityId: user.id, entityName: user.email!,
            metadata: { failures_in_window: after.failures, locked: !after.allowed, window_seconds: AUTH_ATTEMPT_LIMIT.windowSeconds },
          })
        } catch (e) { console.error('MFA failure audit log failed (non-fatal):', e) }
      }
      return NextResponse.json({ error: 'Incorrect code. Check your authenticator app and try again.', code: 'incorrect_code' }, { status: 400 })
    }

    await clearAuthFailures(service, user.id, 'mfa_verify')

    const workspaceId = await resolveActiveWorkspaceId(service, user.id)
    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)

    // ── Login challenge ──────────────────────────────────────────────────
    if (!isEnrolment) {
      // /api/auth/login-event deliberately does not log a sign-in while the
      // second factor is still pending, so this is where it gets recorded —
      // once the sign-in has actually succeeded.
      const { data: { session } } = await supabase.auth.getSession()
      const method = loginMethodFromAmr(decodeJwtPayload(session?.access_token))
      try {
        await logAudit(service, {
          workspaceId: workspaceId || '',
          actorId: user.id, actorEmail: user.email!, actorName,
          eventType: 'security.login_succeeded', entityType: 'user', entityId: user.id, entityName: user.email!,
          metadata: { method, mfa: 'totp' },
        })
      } catch (e) { console.error('Login audit log failed (non-fatal):', e) }
      return NextResponse.json({ ok: true })
    }

    // ── First enrolment ──────────────────────────────────────────────────
    const backupCodes = await issueBackupCodes(service, user.id)

    try {
      await logAudit(service, {
        workspaceId: workspaceId || '',
        actorId: user.id, actorEmail: user.email!, actorName,
        eventType: 'security.mfa_enabled', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: { factor_id: factorId },
      })
    } catch (e) { console.error('MFA enable audit log failed (non-fatal):', e) }

    // One row per active membership, with the error actually read (upstream helper).
    await notifySecurityEvent(service, user.id, 'Two-factor authentication enabled',
      'Your account now requires an authenticator code to sign in.')

    await sendMfaEnabledEmail({ to: user.email!, name: actorName })
      .catch(e => console.error('MFA enable email failed (non-fatal):', e))

    // Turning MFA on invalidates every OTHER session (mirrors what disabling it
    // does): a session that predates MFA — including one an attacker holds —
    // must not simply carry on at aal1.
    const { error: othersErr } = await supabase.auth.signOut({ scope: 'others' })
    if (othersErr) console.error('MFA enable: could not revoke other sessions (non-fatal):', othersErr.message)

    return NextResponse.json({ ok: true, backupCodes })
  } catch (err) {
    console.error('MFA verify error:', err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}
