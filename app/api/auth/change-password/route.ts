export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceClient, createStatelessAuthClient } from '@/lib/supabase/server'
import { userHasAnyMfaMandatoryMembership, resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendPasswordChangedEmail } from '@/lib/email/templates'
import { validatePassword } from '@/lib/auth/password-policy'
import { decodeJwtPayload, authenticationAgeSeconds } from '@/lib/auth/auth-time'
import {
  checkAuthAttemptLimit, recordAuthFailure, clearAuthFailures, lockoutMessage, AUTH_ATTEMPT_LIMIT,
} from '@/lib/auth/attempt-limit'

// POST /api/auth/change-password
//
// What this route does NOT do (by design): write the `security.password_changed`
// audit row. Migration 064 puts a trigger on auth.users.encrypted_password, so
// the database records EVERY password change — this route, the reset flow, or a
// direct supabase.auth.updateUser() from the browser (which bypasses every check
// below unless "Secure password change" is enabled in the Supabase dashboard;
// see README §1.3). An app-written row was both bypassable and, for the reset
// flow, forgeable. This route still sends the notification email and revokes the
// user's other sessions.
//
// FIX (build — Auth independent audit): the "recent sign-in" rule for the
// first-password (OAuth-only) case used the access token's `iat`, which is reset
// on every refresh — see lib/auth/auth-time.ts. It now uses the time of the last
// real authentication. The current-password check is throttled per user and its
// failures audited; the throwaway session that check creates is revoked; a
// non-string/malformed body no longer surfaces raw exception text.

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { password, currentPassword } = await request.json().catch(() => ({})) as {
      password?: unknown; currentPassword?: unknown
    }
    const policyError = validatePassword(password)
    if (policyError) return NextResponse.json({ error: policyError }, { status: 400 })

    const service = createServiceClient()

    const hasPasswordIdentity = (user.identities || []).some((i: any) => i.provider === 'email')
    if (hasPasswordIdentity) {
      if (!currentPassword || typeof currentPassword !== 'string') {
        return NextResponse.json({ error: 'Current password is required' }, { status: 400 })
      }

      const limit = await checkAuthAttemptLimit(service, user.id, 'password_verify')
      if (!limit.allowed) {
        return NextResponse.json(
          { error: lockoutMessage(limit.retryAfterSeconds), code: 'locked', retryAfterSeconds: limit.retryAfterSeconds },
          { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
        )
      }

      const verifyClient = createStatelessAuthClient()
      const { data: verifyData, error: verifyError } = await verifyClient.auth.signInWithPassword({
        email: user.email!, password: currentPassword,
      })
      if (verifyError) {
        await recordAuthFailure(service, user.id, 'password_verify')
        const after = await checkAuthAttemptLimit(service, user.id, 'password_verify')
        try {
          await logAudit(service, {
            workspaceId: (await resolveActiveWorkspaceId(service, user.id)) || '',
            actorId: user.id, actorEmail: user.email!,
            actorName: await resolveActorName(service, user.id, user.user_metadata?.name || user.email!),
            eventType: 'security.password_verify_failed', entityType: 'user', entityId: user.id, entityName: user.email!,
            metadata: { context: 'change_password', failures_in_window: after.failures, locked: !after.allowed, window_seconds: AUTH_ATTEMPT_LIMIT.windowSeconds },
          })
        } catch (e) { console.error('Password verify-failure audit log failed (non-fatal):', e) }
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })
      }
      await clearAuthFailures(service, user.id, 'password_verify')
      // That sign-in minted a real session nobody will ever use. Revoke just it
      // ('local' scope on the stateless client) so throwaway sessions don't pile up.
      if (verifyData?.session) {
        const { error: revokeErr } = await verifyClient.auth.signOut({ scope: 'local' })
        if (revokeErr) console.error('Could not revoke verification session (non-fatal):', revokeErr.message)
      }
    } else {
      // OAuth-only account setting a first password: without a current
      // password to check, require that the person authenticated recently.
      const { data: { session } } = await supabase.auth.getSession()
      const ageSeconds = authenticationAgeSeconds(decodeJwtPayload(session?.access_token))
      if (ageSeconds === null || ageSeconds > 900) {
        return NextResponse.json({
          error: 'For your security, setting a password requires a recent sign-in. Please sign out and back in, then try again.',
        }, { status: 401 })
      }
    }

    // Accounts whose role requires MFA must be at aal2 to change their password.
    // (Every other account with a second factor is held at aal2 by middleware.)
    const mandatory = await userHasAnyMfaMandatoryMembership(user.id)
    if (mandatory) {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.currentLevel !== 'aal2') {
        return NextResponse.json({
          error: 'Re-verify your authenticator code before changing your password.',
        }, { status: 403 })
      }
    }

    const { error } = await supabase.auth.updateUser({ password: password as string })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    // A password change should end every OTHER session (an attacker who had the
    // old password shouldn't stay signed in); this one just proved itself.
    const { error: othersErr } = await supabase.auth.signOut({ scope: 'others' })
    if (othersErr) console.error('Password change session revocation failed (non-fatal):', othersErr.message)

    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)
    await sendPasswordChangedEmail({ to: user.email!, name: actorName, via: 'settings' })
      .catch(e => console.error('Password changed email failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Change password error:', err)
    return NextResponse.json({ error: 'Could not change password' }, { status: 500 })
  }
}
