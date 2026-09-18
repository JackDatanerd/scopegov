export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { hashBackupCode } from '@/lib/utils/backup-codes'
import { sendMfaDisabledEmail } from '@/lib/email/templates'

// Recovery path for a user at aal1 who has lost their authenticator device.
// Supabase's AAL is controlled entirely by its own auth server — we cannot
// forge an aal2 session from here. What we *can* do, with the service
// role, is remove the user's TOTP factor outright once they prove
// ownership of a valid single-use backup code. That drops the requirement
// back to aal1 (unblocking them immediately) and — because
// lib/auth/mfa-policy still applies — middleware will walk them straight
// into forced re-enrollment on the very next request if their role
// requires it. This is a deliberately blunt recovery tool: it trades "the
// old factor" for "immediate access + forced re-setup," never for a
// silent, permanent MFA bypass.
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const { code } = body as { code?: string }
    if (!code) return NextResponse.json({ error: 'Backup code is required' }, { status: 400 })

    const service = createServiceClient()
    const hash = hashBackupCode(code)
    const { data: match } = await (service as any)
      .from('user_mfa_backup_codes')
      .select('id')
      .eq('user_id', user.id)
      .eq('code_hash', hash)
      .is('used_at', null)
      .maybeSingle()

    if (!match) return NextResponse.json({ error: 'That backup code is invalid or has already been used.' }, { status: 400 })

    // Consume the code first — if the factor deletion below fails partway,
    // we fail closed (code burned, user stays locked out and can retry
    // with another code) rather than fail open (code reusable).
    await (service as any).from('user_mfa_backup_codes').update({ used_at: new Date().toISOString() }).eq('id', match.id)

    const { data: factors } = await supabase.auth.mfa.listFactors()
    for (const f of (factors?.totp || [])) {
      await (service as any).auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id })
    }
    // Any other unused backup codes from this generation are now moot —
    // the factor they recovered access from is gone either way.
    await (service as any).from('user_mfa_backup_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id).is('used_at', null)

    // FIX (deep audit, Auth+MFA re-pass — session revocation): this route's
    // whole premise is "the authenticator device is lost or stolen" —
    // the single strongest assume-compromise signal anywhere in this
    // file — yet it never revoked anything beyond the one factor. Any
    // other session/refresh token (e.g. on the lost device itself, still
    // logged in) survived untouched. Scoped to 'others': the caller is
    // actively regaining access through the very session making this
    // call, so that one session must survive the revocation.
    await supabase.auth.signOut({ scope: 'others' }).catch(e => console.error('MFA recovery session revocation failed (non-fatal):', e))

    const { data: userRow } = await (service as any).from('users').select('active_workspace_id').eq('id', user.id).maybeSingle()
    try {
      await logAudit(service, {
        workspaceId: userRow?.active_workspace_id || '',
        actorId: user.id, actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
        eventType: 'security.mfa_backup_code_used', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: { result: 'factor_removed' },
      })
    } catch (e) { console.error('MFA recovery audit log failed (non-fatal):', e) }
    try {
      await (service as any).from('notifications').insert({
        workspace_id: userRow?.active_workspace_id, recipient_id: user.id,
        type: 'security', title: 'Signed in with a backup code',
        body: 'Two-factor authentication was reset using a backup code. Set it up again to keep your account protected.',
      })
    } catch (e) { console.error('MFA recovery notification insert failed (non-fatal):', e) }
    // BUG (fixed): `.catch(() => {})` chained directly on the Supabase
    // insert builder above used to throw `TypeError: insert(...).catch is
    // not a function` in this runtime instead of being swallowed — see
    // verify/route.ts for the full writeup and commit fa95fe0 for the
    // established fix pattern this now follows.
    // FIX (re-audit): fire-and-forget email — not awaited — is unsafe in
    // serverless (the function can freeze/terminate right after the
    // response is sent, before the send completes). Same rule as
    // everywhere else in this codebase: await email sends, even inside a
    // .catch(). This one tells the user their MFA factor was just reset
    // via a backup code — a real security event they need to see.
    await sendMfaDisabledEmail({ to: user.email!, name: user.user_metadata?.name || user.email!, via: 'backup_code_recovery' })
      .catch(e => console.error('MFA recovery email failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('MFA recover error:', err)
    return NextResponse.json({ error: 'Recovery failed' }, { status: 500 })
  }
}
