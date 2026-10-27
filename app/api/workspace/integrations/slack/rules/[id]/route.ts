export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { isUuidString } from '@/lib/utils/uuid'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { parseEventTypes } from '@/lib/integrations/event-input'
import { eventsBeyondPermissions } from '@/lib/integrations/events'
import { loadSlackConnection } from '@/lib/integrations/slack-connection'

type Ctx = { params: Promise<{ id: string }> }

// Edit a rule: its events, or switch it on/off. (To move a rule to another channel, delete it and add a new one.)
export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const auth = await requireIntegrationAdmin('slack')
    if ('response' in auth) return auth.response
    const { session } = auth
    const body = await request.json().catch(() => null) as any
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

    const patch: Record<string, unknown> = {}
    if (body.events !== undefined) {
      const events = parseEventTypes(body.events)
      if (!events.ok) return NextResponse.json({ error: events.error }, { status: 400 })
      const beyond = eventsBeyondPermissions(events.types, p => hasPermission(session, p as any))
      if (beyond.length) return NextResponse.json({ error: `You need more permissions to post: ${beyond.join(', ')}` }, { status: 403 })
      patch.event_types = events.types
    }
    const service = createServiceClient() as any
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      if (body.active) {
        const conn = await loadSlackConnection(service, session.workspaceId)
        if (!conn || conn.status !== 'active') return NextResponse.json({ error: 'Reconnect Slack first.', reconnect: true }, { status: 409 })
        Object.assign(patch, { consecutive_failures: 0, disabled_reason: null })
      }
      patch.active = body.active
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

    const { data, error } = await service.from('integration_subscriptions').update(patch)
      .eq('id', id).eq('workspace_id', session.workspaceId).eq('kind', 'slack').select('id, name').maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.slack_rule_updated', entityType: 'integration_subscription', entityId: id, entityName: data.name,
      metadata: { changed: Object.keys(patch) },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Slack rule update error:', err)
    return NextResponse.json({ error: 'Could not update the rule. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const auth = await requireIntegrationAdmin('slack', { write: false })
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any
    const { data, error } = await service.from('integration_subscriptions').delete()
      .eq('id', id).eq('workspace_id', session.workspaceId).eq('kind', 'slack').select('id, name').maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.slack_rule_deleted', entityType: 'integration_subscription', entityId: id, entityName: data.name,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Slack rule delete error:', err)
    return NextResponse.json({ error: 'Could not delete the rule. Please try again.' }, { status: 500 })
  }
}
