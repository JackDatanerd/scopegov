export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { resolveActiveWorkspaceId } from '@/lib/auth/session'

// FEATURE (deep audit, Auth+MFA section — feature gap): every other
// security-sensitive account action in this app writes to audit_log
// (password changed, MFA enrolled/disabled/backup-code-used/regenerated)
// — but a successful sign-in itself never has, because
// app/(auth)/login/LoginForm.tsx calls supabase.auth.signInWithPassword()
// straight from the browser, with no server route in that path to attach
// a log entry to. For a product whose stated purpose is a governance /
// audit trail, that's a real gap: the most basic security event (who
// accessed the workspace, and when) was the one thing missing from it.
//
// This route is called by LoginForm.tsx right after a password sign-in
// succeeds (the browser call has already set the session cookie by the
// time this fires, so getUser() here reflects the just-established
// session) and by api/auth/callback/route.ts for OAuth and email-
// confirmation logins, which already run server-side.
//
// Deliberately scoped to SUCCESSFUL logins only this round. Logging
// FAILED attempts too would need its own unauthenticated endpoint (no
// session exists yet to attribute the attempt to), which raises a
// separate question this pass doesn't answer: what stops that endpoint
// itself from being used to spam a targeted workspace's audit trail with
// fabricated failure entries. Flagging that as a deliberate deferral
// rather than shipping an under-designed anti-abuse story for a
// compliance-log feature.
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // FIX (deep audit, Auth+MFA re-pass — audit-trail integrity): this
    // route had no check that a sign-in had actually just happened —
    // only that SOME valid session exists right now. Any authenticated
    // user could call it at any point, any number of times, and always
    // get a fresh 'security.login_succeeded' row stamped with the
    // current time. For a product whose stated purpose is a trustworthy
    // governance/audit trail, that let a member pad or dilute their own
    // workspace's login history with fabricated entries — e.g. to bury a
    // genuine unauthorized-login timestamp in noise. Fixed by checking
    // the access token's own `iat` claim: LoginForm.tsx fires this within
    // milliseconds of signInWithPassword() succeeding, so a legitimate
    // call always carries a token minted seconds ago. This doesn't fully
    // close the window — Supabase doesn't rotate the access token on
    // every request, so repeat calls remain possible until it next
    // refreshes (up to its ~1h lifetime) — but it collapses "forever,
    // unlimited" down to "briefly, around a real sign-in," which is the
    // proportionate fix for a route with no other session state to key
    // a stronger check on. Fails closed to a silent no-op (ok:true, no
    // audit row) rather than an error — this is a best-effort logger,
    // never something that should surface as a visible failure.
    const { data: { session } } = await supabase.auth.getSession()
    const tokenPayload = session?.access_token
      ? JSON.parse(Buffer.from(session.access_token.split('.')[1] || '', 'base64').toString('utf8') || '{}')
      : {}
    const issuedAt = typeof tokenPayload.iat === 'number' ? tokenPayload.iat : null
    const ageSeconds = issuedAt ? (Date.now() / 1000 - issuedAt) : Infinity
    if (!issuedAt || ageSeconds > 120) {
      return NextResponse.json({ ok: true })
    }

    // FIX (deep audit, Auth+MFA section, standalone pass): `method` used
    // to be read from the request body (`body?.method === 'google' ?
    // 'google' : 'password'`) — but this route's only real caller,
    // LoginForm.tsx, is the password sign-in form; OAuth logins are
    // logged directly by api/auth/callback/route.ts's own logLoginEvent()
    // with a trustworthy, code-determined method string, never through
    // this HTTP endpoint. That left a client-attested field with no
    // legitimate reason to ever be anything but 'password' — any
    // authenticated user could call this route directly with
    // `{method:'google'}` and forge their own audit trail's login-method
    // field. Since this route's only legitimate caller never varies the
    // method, there's nothing to trust from the client here at all.
    const method = 'password' as const

    const service = createServiceClient()

    // Falls back to the oldest active membership when active_workspace_id
    // is unset — covers the very first login right after signup, before
    // onboarding has run and active_workspace_id has ever been set.
    const workspaceId = await resolveActiveWorkspaceId(service, user.id)

    // No workspace yet (e.g. mid-signup, before onboarding creates one) —
    // audit_log is a per-workspace record with a NOT NULL workspace_id,
    // so there's nowhere to attribute this login to yet. Nothing to log.
    if (!workspaceId) return NextResponse.json({ ok: true })

    await logAudit(service, {
      workspaceId, actorId: user.id,
      actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
      eventType: 'security.login_succeeded', entityType: 'user', entityId: user.id, entityName: user.email!,
      metadata: { method },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    // Best-effort — a logging failure must never block or fail a login
    // that has already succeeded by the time this is called.
    console.error('login-event audit log error (non-fatal):', err)
    return NextResponse.json({ ok: true })
  }
}
