export const runtime = 'nodejs'

// DELETE /api/auth/sessions/[id] — sign ONE session out (any except the one in
// use; the current session signs out through /api/auth/signout). Scoped to the
// caller inside revoke_user_session(), so another person's id is a no-op.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { decodeJwtPayload } from '@/lib/auth/auth-time'
import { logSecurityAudit } from '@/lib/auth/security-audit'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid session' }, { status: 400 })

    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: { session } } = await supabase.auth.getSession()
    if (decodeJwtPayload(session?.access_token)?.session_id === id) {
      return NextResponse.json({ error: 'That\u2019s the session you\u2019re using now. Use Sign out instead.' }, { status: 400 })
    }

    const service = createServiceClient() as any
    const { data: revoked, error } = await service.rpc('revoke_user_session', { p_user: user.id, p_session: id })
    if (error) {
      console.error('revoke_user_session failed:', error.message)
      return NextResponse.json({ error: 'Could not sign that session out' }, { status: 500 })
    }
    if (revoked !== true) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

    await logSecurityAudit(service, {
      actorId: user.id, actorEmail: user.email!,
      actorName: await resolveActorName(service, user.id, user.user_metadata?.name || user.email!),
      eventType: 'security.session_revoked', entityId: user.id, entityName: user.email!,
      metadata: { session_id: id }, allWorkspaces: false, fallbackWorkspaceId: await resolveActiveWorkspaceId(service, user.id),
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Session revoke error:', err)
    return NextResponse.json({ error: 'Could not sign that session out' }, { status: 500 })
  }
}
