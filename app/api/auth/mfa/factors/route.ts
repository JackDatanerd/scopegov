export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { sendMfaDisabledEmail } from '@/lib/email/templates'

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

    const body = await request.json().catch(() => ({}))
    const { factorId } = body as { factorId?: string }
    if (!factorId) return NextResponse.json({ error: 'factorId is required' }, { status: 400 })

    const { error } = await supabase.auth.mfa.unenroll({ factorId })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    const service = createServiceClient()
    // Consume any remaining backup codes — they were tied to the factor
    // that no longer exists; leaving them active would let a leaked code
    // silently persist as a route back into an account.
    await (service as any).from('user_mfa_backup_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id).is('used_at', null)

    const { data: userRow } = await (service as any).from('users').select('active_workspace_id').eq('id', user.id).maybeSingle()
    try {
      await logAudit(service, {
        workspaceId: userRow?.active_workspace_id || '',
        actorId: user.id, actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
        eventType: 'security.mfa_disabled', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: { via: 'user' },
      })
    } catch (e) { console.error('MFA disable audit log failed (non-fatal):', e) }
    try {
      await (service as any).from('notifications').insert({
        workspace_id: userRow?.active_workspace_id, recipient_id: user.id,
        type: 'security', title: 'Two-factor authentication disabled',
        body: 'Your account no longer requires an authenticator code to sign in.',
      })
    } catch (e) { console.error('MFA disable notification insert failed (non-fatal):', e) }
    // BUG (fixed): `.catch(() => {})` chained directly on the Supabase
    // insert builder above used to throw `TypeError: insert(...).catch is
    // not a function` in this runtime instead of being swallowed — see
    // verify/route.ts for the full writeup and commit fa95fe0 for the
    // established fix pattern this now follows.
    sendMfaDisabledEmail({ to: user.email!, name: user.user_metadata?.name || user.email!, via: 'user' })
      .catch(e => console.error('MFA disable email failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('MFA factors DELETE error:', err)
    return NextResponse.json({ error: 'Could not disable two-factor authentication' }, { status: 500 })
  }
}
