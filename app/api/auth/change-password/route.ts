export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceClient, createStatelessAuthClient } from '@/lib/supabase/server'
import { userHasAnyMfaMandatoryMembership } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendPasswordChangedEmail } from '@/lib/email/templates'

// FIX (deep audit, section 5): password changes used to go straight from
// the browser to `supabase.auth.updateUser({ password })` with no backend
// route at all. Disabling MFA on this same account requires proving aal2
// in-session first (see app/api/auth/mfa/factors/route.ts) precisely
// because a hijacked/idle session cookie shouldn't be enough to strip a
// mandatory security control off an account — but changing the password,
// an equally account-taking-over-capable action, had no equivalent check
// anywhere. This route restores that parity: same aal2 rule, only when
// the caller's current role actually mandates MFA.
//
// FIX (deep audit, Auth+MFA re-pass — password confirmation): the aal2
// gate above only ever applied to accounts whose role mandates MFA — for
// everyone else, a live session cookie alone was sufficient to change the
// password, with no proof the caller actually knows it (e.g. a hijacked or
// left-open session, or an XSS-stolen cookie). Now requires the current
// password for any account that has one, regardless of MFA policy,
// verified against Supabase directly rather than trusted from the client.
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { password, currentPassword } = await request.json().catch(() => ({}))
    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    // An OAuth-only account (Google sign-in, no 'email' identity) has no
    // existing password to confirm — this is "set a password for the
    // first time," not "change" one, so there's nothing to verify against.
    const hasPasswordIdentity = (user.identities || []).some((i: any) => i.provider === 'email')
    if (hasPasswordIdentity) {
      if (!currentPassword || typeof currentPassword !== 'string') {
        return NextResponse.json({ error: 'Current password is required' }, { status: 400 })
      }
      const verifyClient = createStatelessAuthClient()
      const { error: verifyError } = await verifyClient.auth.signInWithPassword({
        email: user.email!, password: currentPassword,
      })
      if (verifyError) {
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })
      }
    }

    const service = createServiceClient()
    const { data: userRow } = await (service as any)
      .from('users').select('active_workspace_id').eq('id', user.id).maybeSingle()

    // FIX (deep audit, Auth+MFA re-pass): was scoped to only the active
    // workspace's permissions (same gap as DELETE /api/auth/mfa/factors and
    // mfa-setup's "mandatory" badge — see userHasAnyMfaMandatoryMembership).
    // In practice middleware's blanket aal1-pending-aal2 gate already
    // requires aal2 here for anyone with an enrolled factor regardless of
    // role, so this was never actually bypassable — but it's worth being
    // correct in its own right rather than relying on that other layer.
    const mandatory = await userHasAnyMfaMandatoryMembership(user.id)

    if (mandatory) {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.currentLevel !== 'aal2') {
        return NextResponse.json({
          error: 'Re-verify your authenticator code before changing your password.',
        }, { status: 403 })
      }
    }

    const { error } = await supabase.auth.updateUser({ password })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    // FIX (deep audit, Auth+MFA section): password change previously left
    // no trail at all — every other sensitive account action here (MFA
    // enroll/disable/recover/regenerate) writes to audit_log and emails
    // the user; password change, the classic account-takeover action, did
    // neither. Both non-fatal / best-effort, matching house style.
    await logAudit(service, {
      workspaceId: userRow?.active_workspace_id || '',
      actorId: user.id, actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
      eventType: 'security.password_changed', entityType: 'user', entityId: user.id, entityName: user.email!,
      metadata: { via: 'settings' },
    })
    await sendPasswordChangedEmail({ to: user.email!, name: user.user_metadata?.name || user.email!, via: 'settings' })
      .catch(e => console.error('Password changed email failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
