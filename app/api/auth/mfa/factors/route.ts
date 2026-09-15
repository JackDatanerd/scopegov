export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { sendMfaDisabledEmail } from '@/lib/email/templates'
import { permissionsRequireMfa } from '@/lib/auth/mfa-policy'

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
    const service = createServiceClient()
    const { data: preCheckUser } = await (service as any)
      .from('users').select('active_workspace_id').eq('id', user.id).maybeSingle()
    if (preCheckUser?.active_workspace_id) {
      const { data: memberRow } = await (service as any)
        .from('workspace_members').select('effective_permissions')
        .eq('user_id', user.id).eq('workspace_id', preCheckUser.active_workspace_id)
        .eq('status', 'active').maybeSingle()
      if (permissionsRequireMfa(memberRow?.effective_permissions)) {
        return NextResponse.json({
          error: 'Your role requires two-factor authentication to stay enabled. Ask an admin to change your permissions first.',
        }, { status: 403 })
      }
    }

    const body = await request.json().catch(() => ({}))
    const { factorId } = body as { factorId?: string }
    if (!factorId) return NextResponse.json({ error: 'factorId is required' }, { status: 400 })

    const { error } = await supabase.auth.mfa.unenroll({ factorId })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    // Consume any remaining backup codes — they were tied to the factor
    // that no longer exists; leaving them active would let a leaked code
    // silently persist as a route back into an account.
    await (service as any).from('user_mfa_backup_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id).is('used_at', null)

    try {
      await logAudit(service, {
        workspaceId: preCheckUser?.active_workspace_id || '',
        actorId: user.id, actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
        eventType: 'security.mfa_disabled', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: { via: 'user' },
      })
    } catch (e) { console.error('MFA disable audit log failed (non-fatal):', e) }
    try {
      await (service as any).from('notifications').insert({
        workspace_id: preCheckUser?.active_workspace_id, recipient_id: user.id,
        type: 'security', title: 'Two-factor authentication disabled',
        body: 'Your account no longer requires an authenticator code to sign in.',
      })
    } catch (e) { console.error('MFA disable notification insert failed (non-fatal):', e) }
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
    await sendMfaDisabledEmail({ to: user.email!, name: user.user_metadata?.name || user.email!, via: 'user' })
      .catch(e => console.error('MFA disable email failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('MFA factors DELETE error:', err)
    return NextResponse.json({ error: 'Could not disable two-factor authentication' }, { status: 500 })
  }
}
