export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'
import { decodeJwtPayload, authenticationAgeSeconds, lastAuthenticatedAtSeconds, loginMethodFromAmr } from '@/lib/auth/auth-time'

// POST /api/auth/login-event — called by the login form right after a successful
// password sign-in so it lands in the audit trail (signInWithPassword runs in the
// browser against Supabase Auth, so nothing server-side sees it otherwise).
//
// Audit-trail integrity (the request body carries nothing, and the caller can
// only ever speak for THEIR OWN session):
//   - only a session authenticated in the last 2 minutes is logged. FIX (build —
//     Auth independent audit): "how recent" is now measured from the JWT `amr`
//     authentication timestamp, not the access token's `iat` — `iat` is reset by
//     every token refresh, so every refresh used to reopen a 2-minute window in
//     which this endpoint would happily log another "login";
//   - one row per authentication event: the authentication timestamp is stored
//     and a repeat call for the same one is ignored (it used to log a fresh row
//     each call within the window);
//   - a sign-in that still owes a second factor is NOT logged here (it hasn't
//     succeeded yet). /api/auth/mfa/verify records it once the challenge passes,
//     so the trail no longer shows "login succeeded" for attempts that then fail
//     MFA.
// Always answers { ok: true }: this is a best-effort audit hook, never a reason
// to break sign-in.

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: { session } } = await supabase.auth.getSession()
    const payload = decodeJwtPayload(session?.access_token)
    const ageSeconds = authenticationAgeSeconds(payload)
    if (ageSeconds === null || ageSeconds > 120) return NextResponse.json({ ok: true })

    const hasVerifiedFactor = ((user as any).factors as Array<{ status: string }> | undefined || [])
      .some(f => f.status === 'verified')
    if (hasVerifiedFactor && payload?.aal !== 'aal2') return NextResponse.json({ ok: true })

    const authAt = lastAuthenticatedAtSeconds(payload)!
    const method = loginMethodFromAmr(payload)

    const service = createServiceClient()
    const workspaceId = await resolveActiveWorkspaceId(service, user.id)
    if (!workspaceId) return NextResponse.json({ ok: true })

    const { data: already } = await (service as any)
      .from('audit_log').select('id')
      .eq('actor_id', user.id).eq('event_type', 'security.login_succeeded')
      .eq('metadata->>auth_at', String(authAt)).limit(1)
    if (already && already.length > 0) return NextResponse.json({ ok: true })

    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)
    await logAudit(service, {
      workspaceId, actorId: user.id,
      actorEmail: user.email!, actorName,
      eventType: 'security.login_succeeded', entityType: 'user', entityId: user.id, entityName: user.email!,
      metadata: { method, auth_at: authAt },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('login-event audit log error (non-fatal):', err)
    return NextResponse.json({ ok: true })
  }
}
