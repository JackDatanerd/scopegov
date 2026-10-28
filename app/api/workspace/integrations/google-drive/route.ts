export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { decryptSecret } from '@/lib/integrations/crypto'
import { googleCall, revokeGoogleToken } from '@/lib/integrations/google'
import { DRIVE_EVENT_PERMISSIONS } from '@/lib/integrations/drive-config'

async function loadConnection(service: any, workspaceId: string) {
  const { data, error } = await service.from('integration_connections')
    .select('id, workspace_id, status, config, credentials_enc').eq('workspace_id', workspaceId).eq('provider', 'google_drive').maybeSingle()
  if (error) throw new Error(error.message)
  return data as { id: string; workspace_id: string; status: string; config: any; credentials_enc: string | null } | null
}

// Disconnect. Revokes the refresh token at Google (best effort) and forgets the connection, its rule and its records. The
// PDFs already in the agency's Drive are THEIRS and are left exactly where they are. Allowed on any plan / while lapsed.
export async function DELETE() {
  try {
    const auth = await requireIntegrationAdmin('google_drive', { write: false })
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any
    const conn = await loadConnection(service, session.workspaceId)
    if (!conn) return NextResponse.json({ ok: true })
    try {
      const refresh = JSON.parse(decryptSecret(conn.credentials_enc || '', `${conn.workspace_id}:${conn.id}`)).refresh_token
      if (refresh) await revokeGoogleToken(refresh, googleCall)
    } catch { /* unreadable token: nothing to revoke; it is forgotten below */ }
    const { error } = await service.from('integration_connections').delete().eq('id', conn.id).eq('workspace_id', session.workspaceId)
    if (error) throw new Error(error.message)
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.google_drive_disconnected', entityType: 'integration_connection', entityId: conn.id, entityName: conn.config?.account_email || 'Google Drive',
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Google Drive disconnect error:', err)
    return NextResponse.json({ error: 'Could not disconnect Google Drive. Please try again.' }, { status: 500 })
  }
}

// Edit the archive rule: which executed documents to archive, or switch it on/off.
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireIntegrationAdmin('google_drive')
    if ('response' in auth) return auth.response
    const { session } = auth
    const body = await request.json().catch(() => null) as any
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

    const patch: Record<string, unknown> = {}
    if (body.events !== undefined) {
      if (!Array.isArray(body.events) || body.events.some((e: unknown) => typeof e !== 'string')) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      const events = Array.from(new Set(body.events as string[]))
      const unknown = events.filter(e => !(e in DRIVE_EVENT_PERMISSIONS))
      if (unknown.length) return NextResponse.json({ error: `Cannot archive: ${unknown[0]}` }, { status: 400 })
      const beyond = events.filter(e => !hasPermission(session, DRIVE_EVENT_PERMISSIONS[e] as any))
      if (beyond.length) return NextResponse.json({ error: `You need more permissions to archive: ${beyond.map(e => `${e} (${DRIVE_EVENT_PERMISSIONS[e]})`).join(', ')}` }, { status: 403 })
      patch.event_types = events
    }
    const service = createServiceClient() as any
    const conn = await loadConnection(service, session.workspaceId)
    if (!conn) return NextResponse.json({ error: 'Connect Google Drive first.' }, { status: 409 })
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      if (body.active) {
        if (conn.status !== 'active') return NextResponse.json({ error: 'Reconnect Google Drive first.', reconnect: true }, { status: 409 })
        Object.assign(patch, { consecutive_failures: 0, disabled_reason: null })
      }
      patch.active = body.active
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

    const { data, error } = await service.from('integration_subscriptions').update(patch)
      .eq('connection_id', conn.id).eq('workspace_id', session.workspaceId).eq('kind', 'google_drive').select('id').maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.google_drive_rule_updated', entityType: 'integration_subscription', entityId: data.id, entityName: 'Google Drive archive',
      metadata: { changed: Object.keys(patch) },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Google Drive rule update error:', err)
    return NextResponse.json({ error: 'Could not update Google Drive. Please try again.' }, { status: 500 })
  }
}
