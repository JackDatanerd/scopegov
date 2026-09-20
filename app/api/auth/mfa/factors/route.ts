export const runtime = 'nodejs'

import { notifySecurityEvent } from '@/lib/utils/notify'
import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { sendMfaDisabledEmail } from '@/lib/email/templates'
import { userHasAnyMfaMandatoryMembership, resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: factors } = await supabase.auth.mfa.listFactors()
    const verified = (factors?.totp || []).find(f => f.status === 'verified')

    const service = createServiceClient()
    const { count: unusedBackupCodes } = await (service as any)
      .from('user_mfa_backup_codes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('used_at', null)

    return NextResponse.json({
      enrolled: !!verified,
      factorId: verified?.id || null,
      enrolledAt: verified?.created_at || null,
      unusedBackupCodes: unusedBackupCodes || 0,
    })
  } catch (err) {
    console.error('MFA factors GET error:', err)
    return NextResponse.json({ error: 'Could not load MFA status' }, { status: 500 })
  }
}

// Disabling MFA requires the current session to already be at aal2 —
// i.e. the user proved they hold the factor earlier in this session.
// Otherwise a stolen/idle session cookie alone would be enough to strip
// MFA protection off an account, which defeats the entire point of it.
export async function DELETE(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel !== 'aal2') {
      return NextResponse.json({ error: 'Re-verify your authenticator code before disabling two-factor authentication.' }, { status: 403 })
    }

    // FIX (deep audit, section 5): this route had no server-side check at
    // all for whether the caller's role currently mandates MFA —
    // `permissionsRequireMfa` was only ever checked client-side (to grey
    // out the button in MfaSection.tsx) and in middleware.ts (which blocks
    // the account on its *next* request once it detects aal1-only, forcing
    // re-enrollment). That net still worked — a mandatory account got
    // locked out the moment it tried to do anything else — but this
    // endpoint was the one place that should have refused the disable
    // outright and explained why, rather than silently letting it happen
    // and relying on a different layer to catch the fallout.
    //
    // FIX (deep audit, Auth+MFA re-pass): the check above only looked at
    // the ACTIVE workspace's permissions — a user with a mandatory role in
    // a non-active workspace could still disable MFA here, only to be
    // force-re-enrolled on their very next request by middleware (which
    // correctly checks every membership). Use the same aggregate check
    // middleware uses so this endpoint actually refuses it outright, as
    // the comment above always intended.
    const service = createServiceClient()
    // FIX (deep audit, RLS+permissions section): previously a bare
    // `.select('active_workspace_id')` with no fallback to the oldest
    // active membership (see resolveActiveWorkspaceId's own comment) — an
    // unset active_workspace_id meant both the audit_log row below AND
    // this notifications insert silently failed (workspace_id is NOT NULL
    // on both tables), dropping the MFA-disabled event from the trail
    // entirely instead of attributing it to the user's remaining
    // membership.
    const activeWorkspaceId = await resolveActiveWorkspaceId(service, user.id)
    if (await userHasAnyMfaMandatoryMembership(user.id)) {
      return NextResponse.json({
        error: 'Your role requires two-factor authentication to stay enabled. Ask an admin to change your permissions first.',
      }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { factorId } = body as { factorId?: string }
    if (!factorId) return NextResponse.json({ error: 'factorId is required' }, { status: 400 })

    const { error } = await supabase.auth.mfa.unenroll({ factorId })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    // FIX (deep audit, Auth+MFA section — actor-name staleness): see
    // resolveActorName's own comment in lib/auth/session.ts.
    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)

    // FIX (deep audit, Auth+MFA re-pass — session revocation): disabling
    // two-factor is a straight downgrade of the account's security
    // posture — this route required aal2 to prevent an idle/stolen
    // session cookie from doing it, but never checked whether some OTHER
    // session was sitting at aal2 too (fully verified, on a device the
    // legitimate user doesn't recognize as theirs). Same gap and same fix
    // as change-password: 'others' scope only — the caller just proved
    // aal2 in this session, nothing to revoke here.
    await supabase.auth.signOut({ scope: 'others' }).catch(e => console.error('MFA disable session revocation failed (non-fatal):', e))

    // Consume any remaining backup codes — they were tied to the factor
    // that no longer exists; leaving them active would let a leaked code
    // silently persist as a route back into an account.
    await (service as any).from('user_mfa_backup_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id).is('used_at', null)

    try {
      await logAudit(service, {
        workspaceId: activeWorkspaceId || '',
        actorId: user.id, actorEmail: user.email!, actorName,
        eventType: 'security.mfa_disabled', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: { via: 'user' },
      })
    } catch (e) { console.error('MFA disable audit log failed (non-fatal):', e) }
    // FIX (Notifications & email fix round): this insert used a single, possibly-null
    // workspace id (NOT NULL column → silent failure) and only showed in that one
    // workspace's bell. One row per active membership, with the error actually read.
    await notifySecurityEvent(service, user.id, 'Two-factor authentication disabled',
      'Your account no longer requires an authenticator code to sign in.')
    // BUG (fixed): `.catch(() => {})` chained directly on the Supabase
    // insert builder above used to throw `TypeError: insert(...).catch is
    // not a function` in this runtime instead of being swallowed — see
    // verify/route.ts for the full writeup and commit fa95fe0 for the
    // established fix pattern this now follows.
    // FIX (re-audit): this security-notification email was fire-and-
    // forget — not awaited — which means Vercel's serverless runtime can
    // freeze/terminate the function right after the response is sent,
    // before the send actually completes. Same rule as everywhere else
    // in this codebase: await email sends in serverless, never fire-and-
    // forget them, even inside a .catch(). This is the one that tells a
    // user their two-factor protection was just removed — it must not
    // silently fail to send.
    await sendMfaDisabledEmail({ to: user.email!, name: actorName, via: 'user' })
      .catch(e => console.error('MFA disable email failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('MFA factors DELETE error:', err)
    return NextResponse.json({ error: 'Could not disable two-factor authentication' }, { status: 500 })
  }
}
