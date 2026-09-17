export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { generateBackupCodes } from '@/lib/utils/backup-codes'
import { sendMfaBackupCodesRegeneratedEmail } from '@/lib/email/templates'
import { resolveActiveWorkspaceId } from '@/lib/auth/session'

// Regenerates backup codes — invalidates every previous code. Requires
// aal2 for the same reason DELETE /factors does: this is a sensitive
// account-recovery surface and shouldn't be reachable off an idle session.
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel !== 'aal2') {
      return NextResponse.json({ error: 'Re-verify your authenticator code before regenerating backup codes.' }, { status: 403 })
    }

    const service = createServiceClient()
    const { plaintext, hashes } = generateBackupCodes()

    await (service as any).from('user_mfa_backup_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id).is('used_at', null)
    // FIX (section-by-section re-audit): this insert's error was never
    // checked, unlike the identical insert in mfa/verify/route.ts's
    // first-enrollment path ("don't hand plaintext codes to the user for
    // a set that doesn't exist server-side"). A failed insert here still
    // invalidated the user's OLD codes (the update above already ran) and
    // then returned brand-new plaintext codes that were never persisted —
    // the user would believe they have valid backup codes when in fact
    // they have none. Same guard, applied here too.
    const { error: insertErr } = await (service as any).from('user_mfa_backup_codes').insert(
      hashes.map(code_hash => ({ user_id: user.id, code_hash }))
    )
    if (insertErr) throw insertErr

    // FIX (deep audit, RLS+permissions section): was a bare
    // `.select('active_workspace_id')` with no fallback to the oldest
    // active membership — see resolveActiveWorkspaceId's comment for why
    // that silently dropped this event from the audit trail whenever
    // active_workspace_id was unset.
    await logAudit(service, {
      workspaceId: await resolveActiveWorkspaceId(service, user.id) || '',
      actorId: user.id, actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
      eventType: 'security.mfa_backup_codes_regenerated', entityType: 'user', entityId: user.id, entityName: user.email!,
      metadata: {},
    })
    // FIX (re-audit): fire-and-forget email — not awaited — is unsafe in
    // serverless (the function can freeze/terminate right after the
    // response is sent, before the send completes). Same rule as
    // everywhere else in this codebase: await email sends, even inside a
    // .catch(). This one confirms a backup-code regeneration, which
    // invalidates every prior code — the user needs to actually receive it.
    await sendMfaBackupCodesRegeneratedEmail({ to: user.email!, name: user.user_metadata?.name || user.email! })
      .catch(e => console.error('MFA backup codes regenerated email failed (non-fatal):', e))

    return NextResponse.json({ backupCodes: plaintext })
  } catch (err) {
    console.error('MFA backup codes regenerate error:', err)
    return NextResponse.json({ error: 'Could not regenerate backup codes' }, { status: 500 })
  }
}
