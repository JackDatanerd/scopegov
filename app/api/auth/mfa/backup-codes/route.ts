export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { issueBackupCodes } from '@/lib/auth/backup-code-store'
import { sendMfaBackupCodesRegeneratedEmail } from '@/lib/email/templates'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'

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
    // FIX (build — Auth independent audit): the new set is inserted BEFORE the
    // previously-unused codes are retired (lib/auth/backup-code-store.ts). The
    // old order retired first and inserted second, so a failure in between left
    // the user with no usable codes at all.
    const plaintext = await issueBackupCodes(service, user.id)

    // FIX (deep audit, RLS+permissions section): was a bare
    // `.select('active_workspace_id')` with no fallback to the oldest
    // active membership — see resolveActiveWorkspaceId's comment for why
    // that silently dropped this event from the audit trail whenever
    // active_workspace_id was unset.
    // FIX (deep audit, Auth+MFA section — actor-name staleness): see
    // resolveActorName's own comment in lib/auth/session.ts.
    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)

    await logAudit(service, {
      workspaceId: await resolveActiveWorkspaceId(service, user.id) || '',
      actorId: user.id, actorEmail: user.email!, actorName,
      eventType: 'security.mfa_backup_codes_regenerated', entityType: 'user', entityId: user.id, entityName: user.email!,
      metadata: {},
    })
    // FIX (re-audit): fire-and-forget email — not awaited — is unsafe in
    // serverless (the function can freeze/terminate right after the
    // response is sent, before the send completes). Same rule as
    // everywhere else in this codebase: await email sends, even inside a
    // .catch(). This one confirms a backup-code regeneration, which
    // invalidates every prior code — the user needs to actually receive it.
    await sendMfaBackupCodesRegeneratedEmail({ to: user.email!, name: actorName })
      .catch(e => console.error('MFA backup codes regenerated email failed (non-fatal):', e))

    return NextResponse.json({ backupCodes: plaintext })
  } catch (err) {
    console.error('MFA backup codes regenerate error:', err)
    return NextResponse.json({ error: 'Could not regenerate backup codes' }, { status: 500 })
  }
}
