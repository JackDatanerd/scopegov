export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { HUBSPOT_BACKFILL_COOLDOWN_MS, HUBSPOT_BACKFILL_LIMIT } from '@/lib/integrations/hubspot-config'

// "Sync existing projects": queues the most recent projects that already have a SIGNED SOW and no HubSpot deal yet. Each goes through
// the normal delivery queue (retries, idempotent, visible in the rule's health), creating the company / contact / Closed-won deal.
// Backfilled events add no timeline notes (history would be noise). Bounded (200) and rate-limited (once per 10 minutes).
export async function POST() {
  try {
    const auth = await requireIntegrationAdmin('hubspot')
    if ('response' in auth) return auth.response
    const { session } = auth
    if (!hasPermission(session, 'SEND_SOW')) return NextResponse.json({ error: 'Missing permission: SEND_SOW' }, { status: 403 })
    const service = createServiceClient() as any

    const { data: conn, error: connErr } = await service.from('integration_connections').select('id, status').eq('workspace_id', session.workspaceId).eq('provider', 'hubspot').maybeSingle()
    if (connErr) throw new Error(connErr.message)
    if (!conn || conn.status !== 'active') return NextResponse.json({ error: 'Connect HubSpot first.', reconnect: conn?.status === 'error' }, { status: 409 })
    const { data: rule, error: ruleErr } = await service.from('integration_subscriptions').select('id, active, event_types').eq('connection_id', conn.id).eq('kind', 'hubspot').maybeSingle()
    if (ruleErr) throw new Error(ruleErr.message)
    if (!rule || !rule.active) return NextResponse.json({ error: 'Turn the HubSpot sync on first.' }, { status: 409 })
    if (!(rule.event_types || []).includes('sow.signed')) return NextResponse.json({ error: 'Turn on "SOW signed" first: that is what creates deals.' }, { status: 409 })

    const since = new Date(Date.now() - HUBSPOT_BACKFILL_COOLDOWN_MS).toISOString()
    const { data: recent, error: recentErr } = await service.from('integration_events').select('id').eq('workspace_id', session.workspaceId).eq('entity_type', 'hubspot_backfill').gt('created_at', since).limit(1)
    if (recentErr) throw new Error(recentErr.message)
    if ((recent || []).length) return NextResponse.json({ error: 'A sync was started a few minutes ago. Give it time to finish, then try again.' }, { status: 429 })

    const { data: done, error: doneErr } = await service.from('integration_external_refs').select('local_key').eq('connection_id', conn.id).eq('ref_type', 'deal')
    if (doneErr) throw new Error(doneErr.message)
    const have = new Set<string>((done || []).map((r: any) => r.local_key))

    const { data: sows, error } = await service.from('sow_documents').select('id, project_id, signed_at')
      .eq('workspace_id', session.workspaceId).eq('status', 'signed').order('signed_at', { ascending: false }).limit(HUBSPOT_BACKFILL_LIMIT * 3)
    if (error) throw new Error(error.message)

    // One event per PROJECT (its most recent signed SOW), skipping projects that already have a deal.
    const seen = new Set<string>(); const todo: any[] = []; let alreadySynced = 0
    for (const s of sows || []) {
      if (!s.project_id || seen.has(s.project_id)) continue
      seen.add(s.project_id)
      if (have.has(`deal:${s.project_id}`)) { alreadySynced++; continue }
      todo.push(s)
    }
    const capped = todo.length > HUBSPOT_BACKFILL_LIMIT
    const batch = todo.slice(0, HUBSPOT_BACKFILL_LIMIT)
    let queued = 0
    if (batch.length) {
      const { data: events, error: evErr } = await service.from('integration_events').insert(batch.map((s: any) => ({
        workspace_id: session.workspaceId, event_type: 'sow.signed', entity_type: 'hubspot_backfill', entity_id: s.project_id, project_id: s.project_id,
        data: { document: { type: 'sow', id: s.id }, title: 'Sync an earlier project', summary: 'Copying an already-signed project to HubSpot.', backfill: true },
      }))).select('id')
      if (evErr) throw new Error(evErr.message)
      const { error: delErr } = await service.from('integration_deliveries').insert((events || []).map((e: any) => ({ workspace_id: session.workspaceId, subscription_id: rule.id, event_id: e.id })))
      if (delErr) throw new Error(delErr.message)
      queued = (events || []).length
    }
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.hubspot_backfill', entityType: 'integration_connection', entityId: conn.id, entityName: 'HubSpot',
      metadata: { queued, already_synced: alreadySynced, capped },
    })
    return NextResponse.json({ queued, alreadySynced, capped })
  } catch (err) {
    console.error('HubSpot backfill error:', err)
    return NextResponse.json({ error: 'Could not queue existing projects. Please try again.' }, { status: 500 })
  }
}
