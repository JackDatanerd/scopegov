export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'

// FEATURE (deep audit, Auth+MFA section — feature gap): there was no way
// for a user to see or revoke sessions on other devices/browsers at all.
// A full "list your active sessions" UI needs infrastructure this app
// doesn't have (GoTrue's admin API doesn't expose a per-session listing
// through supabase-js today), but supabase-js's signOut() has supported a
// `scope` option since v2.31 — 'others' revokes every refresh token for
// this user except the one making the call — which covers the common,
// actually-useful case (you think a device might still be logged in
// somewhere — a shared computer, a lost phone, a session from before a
// password reset) without needing to build session enumeration first.
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { error } = await supabase.auth.signOut({ scope: 'others' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const service = createServiceClient()
    const { data: userRow } = await (service as any)
      .from('users').select('active_workspace_id').eq('id', user.id).maybeSingle()

    // Best-effort audit entry — a missing workspace shouldn't fail the
    // actual sign-out, which has already happened by this point.
    if (userRow?.active_workspace_id) {
      await logAudit(service, {
        workspaceId: userRow.active_workspace_id, actorId: user.id,
        actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
        eventType: 'security.other_sessions_revoked', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: {},
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
