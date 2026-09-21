import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { logAudit } from '@/lib/utils/audit'

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { name: nameRaw } = await request.json().catch(() => ({ name: '' })) as { name?: unknown }
    if (typeof nameRaw !== 'string' || !nameRaw.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })
    // FIX (deep audit, Workspace lifecycle section): was a bare .trim() —
    // no length cap, no control-character stripping — unlike the sibling
    // agencyName field in workspace/create and workspace/settings, which
    // both use sanitizeDisplayName for exactly this reason: this value
    // (session.name) flows into audit_log actorName on nearly every
    // mutating route, notification titles, and email greetings across
    // the app, unescaped and unbounded until now.
    const name = sanitizeDisplayName(nameRaw)
    if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 })

    const service = createServiceClient()
    // FIX (section-by-section re-audit): unchecked write, same false-
    // success shape as complete-onboarding — now checked and surfaced.
    const { error } = await (service as any).from('users')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', session.id)
    // FIX (Workspace lifecycle, round 4): raw Postgres error.message was
    // returned straight to the client — the exact info-disclosure pattern
    // workspace/create's own Finding comment already flagged and fixed
    // for itself, missed here. Log server-side only, return a generic
    // message like every other route in this section does.
    if (error) {
      console.error('Profile name update failed:', error)
      return NextResponse.json({ error: 'Failed to update name' }, { status: 500 })
    }

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
    // gap): this route's OWN comment above already establishes that
    // `name` flows unescaped into audit_log.actor_name, notification
    // titles, and email greetings across the entire app — yet the
    // rename itself had no audit trail at all, unlike every other
    // consequential account-level mutation here (password and MFA
    // changes both log AND email — see auth/change-password). Without
    // this, someone could briefly rename themselves to match another
    // teammate around a sensitive action and rename back afterward with
    // zero record of it ever happening. Scoped to the caller's current
    // active workspace since a display name isn't itself
    // workspace-scoped but audit_log.workspace_id is NOT NULL.
    // Best-effort, same as every other audit-log insert in this
    // codebase — must never fail an already-successful name change.
    // Keep the auth-side copy (user_metadata.name, which ends up inside the JWT) in
    // step — set HERE, sanitised. The browser used to call
    // supabase.auth.updateUser({ data: { name } }) itself with no length cap.
    try {
      const { error: metaErr } = await (service as any).auth.admin.updateUserById(session.id, { user_metadata: { name } })
      if (metaErr) console.error('Profile name: auth metadata sync failed (non-fatal):', metaErr.message)
    } catch (e) { console.error('Profile name: auth metadata sync failed (non-fatal):', e) }

    try {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email,
        actorName: name, eventType: 'user.name_changed', entityType: 'user',
        entityId: session.id, entityName: name, metadata: { previousName: session.name },
      })
    } catch (e) { console.error('user.name_changed audit log failed (non-fatal):', e) }

    return NextResponse.json({ ok: true })
  } catch (err) {
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): the
    // write-error branch above was already hardened against this exact
    // leak (round 4) — the outer catch-all was missed, so an unexpected
    // exception still returned raw internals to the client.
    console.error('Profile update error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
