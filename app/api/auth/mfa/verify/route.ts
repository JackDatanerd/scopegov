export const runtime = 'nodejs'

// POST /api/auth/mfa/verify — verify a TOTP code for a factor.
//
// Two situations, told apart by the factor's own status:
//   - factor already `verified`  → a sign-in CHALLENGE (session goes aal1 → aal2)
//   - factor still `unverified`  → FIRST-TIME ENROLMENT completion (backup codes issued)
//
// ATTEMPT LIMIT (audit round 2): a slot is RESERVED atomically before the code is
// checked (lib/auth/attempt-limit.ts), so a burst of parallel guesses can no longer
// all slip past the check. The same lockout is enforced INSIDE Supabase Auth by
// hook_mfa_verification_attempt (migration 068), which is what stops guesses that
// bypass this route and call GoTrue directly.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { notifySecurityEvent } from '@/lib/utils/notify'
import { issueBackupCodes } from '@/lib/auth/backup-code-store'
import { sendMfaEnabledEmail } from '@/lib/email/templates'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'
import { decodeJwtPayload, loginMethodFromAmr, authenticationAgeSeconds } from '@/lib/auth/auth-time'
import {
  beginAuthAttempt, releaseAuthAttempt, clearAuthFailures, lockedResponseBody, AUTH_ATTEMPT_LIMIT,
} from '@/lib/auth/attempt-limit'
import { logSecurityAudit } from '@/lib/auth/security-audit'
import { logLoginOnce } from '@/lib/auth/login-audit'

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
    const code = body.code.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.' }, { status: 400 })
    }

    const service = createServiceClient()

    const begin = await beginAuthAttempt(service, user.id, 'mfa_verify')
    if (!begin.allowed) {
      return NextResponse.json(lockedResponseBody(begin), { status: 429, headers: { 'Retry-After': String(begin.retryAfterSeconds) } })
    }

    const { data: factorList } = await supabase.auth.mfa.listFactors()
    const factor = (factorList?.all || []).find(f => f.id === factorId)
    if (!factor) {
      await releaseAuthAttempt(service, begin.attemptId)
      return NextResponse.json({
        error: 'That authenticator is no longer registered on this account. Refresh the page and try again.',
        code: 'factor_not_found',
      }, { status: 400 })
    }
    const isEnrolment = factor.status !== 'verified'

    // Completing an enrolment while a DIFFERENT factor is already verified is only
    // legitimate from a session that has itself passed that factor (aal2). Without
    // this, a password-only session could add its own authenticator and thereby
    // "pass" MFA. (/api/auth/mfa/enroll already refuses to start one.)
    if (isEnrolment && (factorList?.totp || []).length > 0) {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.currentLevel !== 'aal2') {
        await releaseAuthAttempt(service, begin.attemptId)
        return NextResponse.json({
          error: 'Two-factor authentication is already set up on this account. Sign in with your existing authenticator first.',
          code: 'already_enrolled',
        }, { status: 403 })
      }
    }

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
    if (error) {
      const status = (error as any).status as number | undefined
      const errCode = (error as any).code as string | undefined
      const message = String((error as any).message || '')

      // Locked by the Auth hook (guesses made outside this route count too).
      if (errCode === 'mfa_verification_rejected' || /too many incorrect attempts/i.test(message)) {
        await releaseAuthAttempt(service, begin.attemptId)
        return NextResponse.json(
          { error: message || 'Too many incorrect attempts. Try again in a few minutes.', code: 'locked', retryAfterSeconds: 60 },
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      }

      if (status === 429 || errCode === 'over_request_rate_limit') {
        await releaseAuthAttempt(service, begin.attemptId)
        return NextResponse.json(
          { error: 'Too many attempts right now. Wait a minute and try again.', code: 'rate_limited' },
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      }

      const wrongCode = errCode === 'mfa_verification_failed' || /invalid totp|incorrect|verification failed/i.test(message)
      if (!wrongCode) {
        await releaseAuthAttempt(service, begin.attemptId)
        console.error('MFA challengeAndVerify failed:', errCode, message)
        return NextResponse.json({ error: 'We couldn\u2019t verify that code right now. Please try again.', code: 'verify_unavailable' }, { status: 502 })
      }

      // A genuine wrong code: the reservation stays as the recorded failure.
      if (!isEnrolment) {
        try {
          await logAudit(service, {
            workspaceId: (await resolveActiveWorkspaceId(service, user.id)) || '',
            actorId: user.id, actorEmail: user.email!,
            actorName: await resolveActorName(service, user.id, user.user_metadata?.name || user.email!),
            eventType: 'security.mfa_challenge_failed', entityType: 'user', entityId: user.id, entityName: user.email!,
            metadata: {
              failures_in_window: begin.failures,
              locked: begin.failures >= AUTH_ATTEMPT_LIMIT.maxFailures,
              window_seconds: AUTH_ATTEMPT_LIMIT.windowSeconds,
            },
          })
        } catch (e) { console.error('MFA failure audit log failed (non-fatal):', e) }
      }
      return NextResponse.json({ error: 'Incorrect code. Check your authenticator app and try again.', code: 'incorrect_code' }, { status: 400 })
    }

    await clearAuthFailures(service, user.id, 'mfa_verify')

    const workspaceId = await resolveActiveWorkspaceId(service, user.id)
    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)

    if (!isEnrolment) {
      // The auth.sessions trigger (migration 068) records this sign-in when the
      // session reaches aal2; this is the fallback for a database without it.
      const { data: { session } } = await supabase.auth.getSession()
      const tokenPayload = decodeJwtPayload(session?.access_token)
      const method = loginMethodFromAmr(tokenPayload)
      const signedInAgo = authenticationAgeSeconds(tokenPayload)
      try {
        await logLoginOnce(service, {
          workspaceId: workspaceId || '', userId: user.id, email: user.email!, name: actorName,
          method, extra: { mfa: 'totp' }, sinceSeconds: (signedInAgo ?? 60) + 5,
        })
      } catch (e) { console.error('Login audit log failed (non-fatal):', e) }
      return NextResponse.json({ ok: true })
    }

    // ── First-time enrolment completed ──
    const backupCodes = await issueBackupCodes(service, user.id)

    await logSecurityAudit(service, {
      actorId: user.id, actorEmail: user.email!, actorName,
      eventType: 'security.mfa_enabled', entityId: user.id, entityName: user.email!,
      metadata: { factor_id: factorId }, fallbackWorkspaceId: workspaceId,
    })

    await notifySecurityEvent(service, user.id, 'Two-factor authentication enabled',
      'Your account now requires an authenticator code to sign in.')

    await sendMfaEnabledEmail({ to: user.email!, name: actorName })
      .catch(e => console.error('MFA enable email failed (non-fatal):', e))

    // Enabling MFA is the moment to cut off any session that got in without it.
    const { error: othersErr } = await supabase.auth.signOut({ scope: 'others' })
    if (othersErr) console.error('MFA enable: could not revoke other sessions (non-fatal):', othersErr.message)

    return NextResponse.json({ ok: true, backupCodes })
  } catch (err) {
    console.error('MFA verify error:', err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}
