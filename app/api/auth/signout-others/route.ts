export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'

// FEATURE (deep audit, Auth+MFA section — feature gap): originally there
// was no way for a user to see or revoke sessions on other devices/
// browsers at all. supabase-js's signOut() has supported a `scope` option
// since v2.31 — 'others' revokes every refresh token for this user except
// the one making the call — which covers the common, actually-useful case
// (you think a device might still be logged in somewhere — a shared
// computer, a lost phone, a session from before a password reset) in one
// call, with no per-session enumeration needed.
//
// A full per-session list/revoke UI (reading auth.sessions directly via a
// SECURITY DEFINER function, since GoTrue's admin API doesn't expose
// per-session listing through supabase-js) was since built separately —
// see list_user_sessions()/revoke_user_session() (migration 068),
// GET /api/auth/sessions, DELETE /api/auth/sessions/[id], and
// components/settings/SessionsSection.tsx. This route is kept alongside
// it as the one-click "sign out everywhere else" action; it doesn't
// require knowing which sessions exist first.
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { error } = await supabase.auth.signOut({ scope: 'others' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const service = createServiceClient()

    // FIX (deep audit, Auth+MFA independent re-pass): this used to read
    // the bare `users.active_workspace_id` with no fallback — the exact
    // gap resolveActiveWorkspaceId() (lib/auth/session.ts) was built to
    // close for change-password, mfa/factors, mfa/backup-codes, and
    // password-changed, just never extended here. A user whose
    // active_workspace_id is unset (e.g. right after leaving/losing their
    // active workspace) would silently lose this audit entry even though
    // they have another active membership resolveActiveWorkspaceId's
    // fallback would find.
    const workspaceId = await resolveActiveWorkspaceId(service, user.id)

    // Best-effort audit entry — a missing workspace shouldn't fail the
    // actual sign-out, which has already happened by this point.
    if (workspaceId) {
      // FIX (deep audit, Auth+MFA section — actor-name staleness): see
      // resolveActorName's own comment in lib/auth/session.ts.
      const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)
      await logAudit(service, {
        workspaceId, actorId: user.id,
        actorEmail: user.email!, actorName,
        eventType: 'security.other_sessions_revoked', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: {},
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('auth/signout-others error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
