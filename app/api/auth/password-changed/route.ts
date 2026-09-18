export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { sendPasswordChangedEmail } from '@/lib/email/templates'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'

// FIX (deep audit, Auth+MFA section): /reset-password calls
// supabase.auth.updateUser({ password }) directly from the browser SDK —
// there's no server route in that flow to attach an audit log entry or a
// security email to, unlike the Settings-page change (api/auth/change-password),
// which already does both. This endpoint fills that gap: the reset-password
// page calls it right after its own updateUser() succeeds, and BEFORE it
// signs itself out (the recovery session is what proves this is legitimate —
// no separate re-auth needed, same trust boundary Supabase's own recovery
// flow already relies on).
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

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
      eventType: 'security.password_changed', entityType: 'user', entityId: user.id, entityName: user.email!,
      metadata: { via: 'reset_link' },
    })
    await sendPasswordChangedEmail({ to: user.email!, name: actorName, via: 'reset_link' })
      .catch(e => console.error('Password changed email failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    // Best-effort — a failure here must never block the user from
    // finishing their password reset, which has already succeeded by
    // the time this is called.
    console.error('password-changed notify error (non-fatal):', err)
    return NextResponse.json({ ok: true })
  }
}
