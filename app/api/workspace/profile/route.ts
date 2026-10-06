import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { sanitizeDisplayName, displayNameTooLong, DISPLAY_NAME_MAX } from '@/lib/utils/sanitize'
import { logSecurityAudit } from '@/lib/auth/security-audit'

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // FIX (Workspace lifecycle independent pass 2 — B4): `.catch()` only covers a body that fails
    // to parse. A body that parses to JSON `null` made the destructuring throw and came back as a
    // 500 instead of the 400 below. Read into a variable and use optional access.
    const reqBody = await request.json().catch(() => null) as { name?: unknown } | null
    const nameRaw = reqBody?.name
    if (typeof nameRaw !== 'string' || !nameRaw.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })
    // FIX (deep audit, Workspace lifecycle section): was a bare .trim() —
    // no length cap, no control-character stripping — unlike the sibling
    // agencyName field in workspace/create and workspace/settings, which
    // both use sanitizeDisplayName for exactly this reason: this value
    // (session.name) flows into audit_log actorName on nearly every
    // mutating route, notification titles, and email greetings across
    // the app, unescaped and unbounded until now.
    // Settings pass 17: a name over the cap used to be stored cut short behind a success message.
    if (displayNameTooLong(nameRaw)) return NextResponse.json({ error: `Name must be ${DISPLAY_NAME_MAX} characters or fewer` }, { status: 400 })
    const name = sanitizeDisplayName(nameRaw)
    if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 })

    const service = createServiceClient()

    // FIX (Workspace lifecycle independent pass 3): an unchanged name (saving the form without
    // editing it, a double submit) still rewrote users.name and wrote a user.name_changed audit
    // entry whose previousName equalled the new name — noise in the very trail that exists to spot
    // rename-based impersonation. Compare against the stored name (not session.name, which can be
    // an Auth-metadata / email fallback) and skip the write and the entry when nothing changed.
    const { data: current, error: readErr } = await (service as any).from('users')
      .select('name').eq('id', session.id).maybeSingle()
    if (readErr) {
      console.error('Profile name read failed:', readErr)
      return NextResponse.json({ error: 'Failed to update name' }, { status: 500 })
    }
    const previousName: string = current?.name || ''
    const changed = previousName !== name

    if (changed) {
      // FIX (section-by-section re-audit): unchecked write, same false-
      // success shape as complete-onboarding — now checked and surfaced.
      const { error } = await (service as any).from('users')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', session.id)
      // FIX (Workspace lifecycle, round 4): raw Postgres error.message was returned straight to
      // the client; log server-side only, generic message to the caller.
      if (error) {
        console.error('Profile name update failed:', error)
        return NextResponse.json({ error: 'Failed to update name' }, { status: 500 })
      }
    }

    // Keep the auth-side copy (user_metadata.name, which ends up inside the JWT) in step — set
    // HERE, sanitised. Also runs for an unchanged name so any drift between the two heals.
    try {
      const { error: metaErr } = await (service as any).auth.admin.updateUserById(session.id, { user_metadata: { name } })
      if (metaErr) console.error('Profile name: auth metadata sync failed (non-fatal):', metaErr.message)
    } catch (e) { console.error('Profile name: auth metadata sync failed (non-fatal):', e) }

    if (!changed) return NextResponse.json({ ok: true, unchanged: true })

    // The display name is account-wide (public.users.name) and shows in EVERY workspace the person
    // belongs to, but this entry used to be written only to whichever workspace was active at the
    // time — so someone could rename to match a teammate while in workspace A, act in workspace B
    // under the borrowed name, and leave no trace in B's log. Same treatment as the other
    // person-level security events (password, MFA): written to every workspace they are active in.
    // Best-effort (logSecurityAudit never throws) — must never fail an already-successful rename.
    await logSecurityAudit(service, {
      actorId: session.id, actorEmail: session.email, actorName: name,
      eventType: 'user.name_changed', entityId: session.id, entityName: name,
      metadata: { previousName },
      fallbackWorkspaceId: session.workspaceId,
    })

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
