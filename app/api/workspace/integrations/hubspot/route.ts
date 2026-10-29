export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { revokeHubspotToken, hubspotCall, stagesOf } from '@/lib/integrations/hubspot'
import { HUBSPOT_EVENT_PERMISSIONS } from '@/lib/integrations/hubspot-config'
import { hubspotAs, hubspotRefreshToken, loadHubspotConnection } from '@/lib/integrations/hubspot-connection'

// Disconnect. Revokes the refresh token at HubSpot (best effort) and forgets the connection, its rule and its records. Everything already
// created in HubSpot (companies, contacts, deals, notes) is the customer's and is left exactly where it is. Allowed on any plan / lapsed.
export async function DELETE() {
  try {
    const auth = await requireIntegrationAdmin('hubspot', { write: false })
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any
    const conn = await loadHubspotConnection(service, session.workspaceId)
    if (!conn) return NextResponse.json({ ok: true })
    try { await revokeHubspotToken(hubspotRefreshToken(conn), hubspotCall) } catch { /* unreadable token: nothing to revoke */ }
    const { error } = await service.from('integration_connections').delete().eq('id', conn.id).eq('workspace_id', session.workspaceId)
    if (error) throw new Error(error.message)
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.hubspot_disconnected', entityType: 'integration_connection', entityId: conn.id, entityName: conn.config?.hub_domain || 'HubSpot',
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('HubSpot disconnect error:', err)
    return NextResponse.json({ error: 'Could not disconnect HubSpot. Please try again.' }, { status: 500 })
  }
}

// Edit the sync rule: which events, which deal pipeline, whether deal amounts are sent, or switch it on/off.
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireIntegrationAdmin('hubspot')
    if ('response' in auth) return auth.response
    const { session } = auth
    const body = await request.json().catch(() => null) as any
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

    const service = createServiceClient() as any
    const conn = await loadHubspotConnection(service, session.workspaceId)
    if (!conn) return NextResponse.json({ error: 'Connect HubSpot first.' }, { status: 409 })
    const { data: rule, error: ruleErr } = await service.from('integration_subscriptions').select('id, config').eq('connection_id', conn.id).eq('kind', 'hubspot').maybeSingle()
    if (ruleErr) throw new Error(ruleErr.message)
    if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const patch: Record<string, unknown> = {}
    const config: Record<string, unknown> = { ...(rule.config || {}) }
    if (body.events !== undefined) {
      if (!Array.isArray(body.events) || body.events.some((e: unknown) => typeof e !== 'string')) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      const events = Array.from(new Set(body.events as string[]))
      const unknown = events.filter(e => !(e in HUBSPOT_EVENT_PERMISSIONS))
      if (unknown.length) return NextResponse.json({ error: `HubSpot cannot sync: ${unknown[0]}` }, { status: 400 })
      const beyond = events.filter(e => !hasPermission(session, HUBSPOT_EVENT_PERMISSIONS[e] as any))
      if (beyond.length) return NextResponse.json({ error: `You need more permissions to sync: ${beyond.map(e => `${e} (${HUBSPOT_EVENT_PERMISSIONS[e]})`).join(', ')}` }, { status: 403 })
      patch.event_types = events
    }
    if (body.include_amounts !== undefined) {
      if (typeof body.include_amounts !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      // Contract values are financial data: only someone who can see them in ScopeGov may send them to a CRM.
      if (body.include_amounts && !hasPermission(session, 'VIEW_FINANCIALS')) return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS (deal amounts are contract values).' }, { status: 403 })
      config.include_amounts = body.include_amounts
    }
    if (body.pipeline_id !== undefined) {
      if (typeof body.pipeline_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.pipeline_id)) return NextResponse.json({ error: 'Invalid pipeline.' }, { status: 400 })
      // Verify with HubSpot (never trust an id from the browser) and make sure it has the stages a deal needs.
      const pr = await hubspotAs(service, conn, 'GET', `/crm/v3/pipelines/deals/${encodeURIComponent(body.pipeline_id)}`)
      if (!pr.ok) return NextResponse.json({ error: pr.reconnect ? 'HubSpot needs to be reconnected.' : 'HubSpot could not find that pipeline.', reconnect: pr.reconnect }, { status: pr.reconnect ? 409 : 400 })
      const st = stagesOf(pr.json)
      if (!st.won || !st.lost) return NextResponse.json({ error: 'That pipeline needs both a "Closed won" and a "Closed lost" stage.' }, { status: 400 })
      config.pipeline_id = body.pipeline_id
    }
    if (JSON.stringify(config) !== JSON.stringify(rule.config || {})) patch.config = config
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      if (body.active) {
        if (conn.status !== 'active') return NextResponse.json({ error: 'Reconnect HubSpot first.', reconnect: true }, { status: 409 })
        Object.assign(patch, { consecutive_failures: 0, disabled_reason: null })
      }
      patch.active = body.active
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

    const { error } = await service.from('integration_subscriptions').update(patch).eq('id', rule.id).eq('workspace_id', session.workspaceId)
    if (error) throw new Error(error.message)
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.hubspot_rule_updated', entityType: 'integration_subscription', entityId: rule.id, entityName: 'HubSpot sync',
      metadata: { changed: Object.keys(patch).concat(body.include_amounts !== undefined ? ['include_amounts'] : [], body.pipeline_id !== undefined ? ['pipeline_id'] : []) },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('HubSpot rule update error:', err)
    return NextResponse.json({ error: 'Could not update HubSpot. Please try again.' }, { status: 500 })
  }
}
