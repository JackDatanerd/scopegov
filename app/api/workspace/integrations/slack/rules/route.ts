export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/session'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { logAudit } from '@/lib/utils/audit'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { parseEventTypes } from '@/lib/integrations/event-input'
import { eventsBeyondPermissions } from '@/lib/integrations/events'
import { loadSlackConnection, slackAs } from '@/lib/integrations/slack-connection'
import { SLACK_POST_URL } from '@/lib/integrations/slack-config'
import { MAX_SLACK_RULES } from '@/lib/integrations/plans'

const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/

// Creates a routing rule: "post these events to this channel". One rule per channel (it holds a list of events).
// The channel is verified with Slack (never trusting a name the browser sends), and a private channel the app has not been
// invited to is refused up front with the fix, instead of failing silently later.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireIntegrationAdmin('slack')
    if ('response' in auth) return auth.response
    const { session } = auth
    const body = await request.json().catch(() => null) as any
    const channelId = String(body?.channel_id ?? '')
    if (!CHANNEL_ID.test(channelId)) return NextResponse.json({ error: 'Choose a channel.' }, { status: 400 })
    const events = parseEventTypes(body?.events)
    if (!events.ok) return NextResponse.json({ error: events.error }, { status: 400 })
    const beyond = eventsBeyondPermissions(events.types, p => hasPermission(session, p as any))
    if (beyond.length) return NextResponse.json({ error: `You need more permissions to post: ${beyond.join(', ')}` }, { status: 403 })

    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp

    const service = createServiceClient() as any
    const conn = await loadSlackConnection(service, session.workspaceId)
    if (!conn || conn.status !== 'active') return NextResponse.json({ error: 'Connect Slack first.', reconnect: conn?.status === 'error' }, { status: 409 })

    const { count, error: countErr } = await service.from('integration_subscriptions')
      .select('id', { count: 'exact', head: true }).eq('workspace_id', session.workspaceId).eq('kind', 'slack')
    if (countErr) throw new Error(countErr.message)
    if ((count ?? 0) >= MAX_SLACK_RULES) return NextResponse.json({ error: `A workspace can have up to ${MAX_SLACK_RULES} Slack rules.` }, { status: 409 })

    const info = await slackAs(service, conn, 'conversations.info', { channel: channelId })
    if (!info.ok) return NextResponse.json({ error: info.reconnect ? 'Slack needs to be reconnected.' : 'Slack could not find that channel.', reconnect: info.reconnect }, { status: info.reconnect ? 409 : 400 })
    const ch = info.body.channel || {}
    if (ch.is_archived) return NextResponse.json({ error: 'That channel is archived.' }, { status: 400 })
    if ((ch.is_private || ch.is_group) && !ch.is_member)
      return NextResponse.json({ error: `The ScopeGov app is not in #${ch.name || 'that channel'}. In Slack, open the channel and type /invite @ScopeGov, then try again.` }, { status: 400 })

    const { data, error } = await service.from('integration_subscriptions').insert({
      workspace_id: session.workspaceId, connection_id: conn.id, kind: 'slack', name: `#${String(ch.name || channelId).slice(0, 78)}`,
      target_url: SLACK_POST_URL, event_types: events.types, secret_enc: null, created_by: session.id,
      config: { channel_id: channelId, channel_name: ch.name || null, is_private: !!(ch.is_private || ch.is_group) },
    }).select('id').single()
    if (error) {
      if ((error as any).code === '23505') return NextResponse.json({ error: 'That channel already has a rule. Edit it instead.' }, { status: 409 })
      throw new Error(error.message)
    }
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.slack_rule_created', entityType: 'integration_subscription', entityId: data.id, entityName: `#${ch.name || channelId}`,
      metadata: { events: events.types, private: !!(ch.is_private || ch.is_group) },
    })
    return NextResponse.json({ id: data.id }, { status: 201 })
  } catch (err) {
    console.error('Slack rule create error:', err)
    return NextResponse.json({ error: 'Could not create the rule. Please try again.' }, { status: 500 })
  }
}
