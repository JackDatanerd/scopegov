export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActorName } from '@/lib/auth/session'
import { sendPasswordChangedEmail } from '@/lib/email/templates'
import { validatePassword } from '@/lib/auth/password-policy'
import { decodeJwtPayload, authenticationAgeSeconds, isMailboxProvenSession } from '@/lib/auth/auth-time'

// POST /api/auth/reset-password — set a new password from a password-recovery
// session (the page at /reset-password, reached from the emailed link).
//
// FIX (build — Auth independent audit, MEDIUM): the reset page used to call
// supabase.auth.updateUser({ password }) straight from the browser and then POST
// to /api/auth/password-changed to record it. That second endpoint proved
// nothing — any signed-in session, including one still waiting on its second
// factor, could call it in a loop to forge `security.password_changed` audit rows
// and email the account owner "your password was changed" on demand. The change
// is now made HERE, server-side, so the app knows it happened; the audit row is
// written by the database trigger on auth.users (migration 064) and the old
// endpoint is gone.
//
// Middleware holds any session with a second factor pending at the aal2 gate, so
// an MFA-enrolled user reaches this route only after completing the challenge
// (the page sends them to /mfa-challenge when it gets a 401/403 here).

const RECENT_AUTH_SECONDS = 900

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Your reset link has expired. Request a new one.', code: 'no_session' }, { status: 401 })

    const { password } = await request.json().catch(() => ({})) as { password?: unknown }
    const policyError = validatePassword(password, { email: user.email })
    if (policyError) return NextResponse.json({ error: policyError }, { status: 400 })

    // This endpoint exists for recovery links, which are consumed moments before
    // the form is submitted. A long-lived normal session has Settings → Password
    // (which asks for the current password) and must not use this as a way
    // around it.
    const { data: { session } } = await supabase.auth.getSession()
    const tokenPayload = decodeJwtPayload(session?.access_token)

    // FIX (Auth+MFA audit round 2): only a session that was JUST created by proving
    // control of the mailbox (recovery / OTP / magic link) may set a password with
    // no current password. This used to accept ANY session that had authenticated
    // within 15 minutes — an ordinary password sign-in, or a hijacked cookie — which
    // bypassed the current-password check, throttle and audit that
    // /api/auth/change-password enforces.
    if (!isMailboxProvenSession(tokenPayload)) {
      return NextResponse.json({
        error: 'This page is only for password-reset links. To change your password while signed in, use Settings \u2192 Account.',
        code: 'not_recovery_session',
      }, { status: 403 })
    }

    const ageSeconds = authenticationAgeSeconds(tokenPayload)
    if (ageSeconds === null || ageSeconds > RECENT_AUTH_SECONDS) {
      return NextResponse.json({
        error: 'This reset session has expired. Request a new reset link, or change your password from Settings while signed in.',
        code: 'stale_session',
      }, { status: 401 })
    }

    const { error } = await supabase.auth.updateUser({ password: password as string })
    if (error) {
      const code = (error as any).code as string | undefined
      if (code === 'insufficient_aal' || /aal2/i.test(error.message)) {
        return NextResponse.json({ error: 'Verify your authenticator code to continue.', code: 'mfa_required' }, { status: 403 })
      }
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    const service = createServiceClient()
    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)
    await sendPasswordChangedEmail({ to: user.email!, name: actorName, via: 'reset_link' })
      .catch(e => console.error('Password changed email failed (non-fatal):', e))

    // A reset ends EVERY session, this one included — the person signs in fresh
    // with the new password.
    const { error: signOutErr } = await supabase.auth.signOut()
    if (signOutErr) console.error('Password reset sign-out failed (non-fatal):', signOutErr.message)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Password reset error:', err)
    return NextResponse.json({ error: 'Could not reset password' }, { status: 500 })
  }
}
