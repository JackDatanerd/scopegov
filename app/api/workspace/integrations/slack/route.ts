export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { connectionToken, loadSlackConnection } from '@/lib/integrations/slack-connection'
import { slackCall } from '@/lib/integrations/slack'

// Disconnect. Revokes the bot token at Slack (best effort — if Slack is unreachable the token is still forgotten here)
// and deletes the connection; its routing rules go with it (ON DELETE CASCADE). Allowed on any plan and while lapsed, so a
// workspace can always cut the link.
export async function DELETE() {
  try {
    const auth = await requireIntegrationAdmin('slack', { write: false })
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any
    const conn = await loadSlackConnection(service, session.workspaceId)
    if (!conn) return NextResponse.json({ ok: true })
    try { await slackCall('auth.revoke', connectionToken(conn), {}) } catch (e) { console.error('Slack auth.revoke failed (token forgotten locally anyway):', (e as Error).message) }
    const { error } = await service.from('integration_connections').delete().eq('id', conn.id).eq('workspace_id', session.workspaceId)
    if (error) throw new Error(error.message)
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.slack_disconnected', entityType: 'integration_connection', entityId: conn.id, entityName: conn.config?.team_name || 'Slack',
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Slack disconnect error:', err)
    return NextResponse.json({ error: 'Could not disconnect Slack. Please try again.' }, { status: 500 })
  }
}
