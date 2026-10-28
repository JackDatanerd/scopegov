export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { BACKFILL_COOLDOWN_MS, BACKFILL_LIMIT, DRIVE_EVENT_PERMISSIONS } from '@/lib/integrations/drive-config'

// "Archive past documents": queues the most recent already-executed documents (that have a frozen PDF) that are not in Drive yet.
// Each goes through the normal delivery queue, so it retries, is idempotent (a document already archived is a no-op) and shows up
// in the rule's health like any other. Bounded (200 per type) and rate-limited (once per 10 minutes) so a click cannot flood Drive.
const KINDS = [
  { event: 'sow.signed', type: 'sow', table: 'sow_documents', status: 'signed', order: 'signed_at' },
  { event: 'change_order.accepted', type: 'change_order', table: 'change_orders', status: 'accepted', order: 'accepted_at' },
] as const

export async function POST() {
  try {
    const auth = await requireIntegrationAdmin('google_drive')
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any

    const { data: conn, error: connErr } = await service.from('integration_connections')
      .select('id, status').eq('workspace_id', session.workspaceId).eq('provider', 'google_drive').maybeSingle()
    if (connErr) throw new Error(connErr.message)
    if (!conn || conn.status !== 'active') return NextResponse.json({ error: 'Connect Google Drive first.', reconnect: conn?.status === 'error' }, { status: 409 })
    const { data: rule, error: ruleErr } = await service.from('integration_subscriptions')
      .select('id, active, event_types').eq('connection_id', conn.id).eq('kind', 'google_drive').maybeSingle()
    if (ruleErr) throw new Error(ruleErr.message)
    if (!rule || !rule.active) return NextResponse.json({ error: 'Turn the archive on first.' }, { status: 409 })

    // Rate limit: the previous backfill leaves marker events (entity_type 'drive_backfill').
    const since = new Date(Date.now() - BACKFILL_COOLDOWN_MS).toISOString()
    const { data: recent, error: recentErr } = await service.from('integration_events')
      .select('id').eq('workspace_id', session.workspaceId).eq('entity_type', 'drive_backfill').gt('created_at', since).limit(1)
    if (recentErr) throw new Error(recentErr.message)
    if ((recent || []).length) return NextResponse.json({ error: 'A backfill was started a few minutes ago. Give it time to finish, then try again.' }, { status: 429 })

    const { data: done, error: doneErr } = await service.from('integration_external_refs')
      .select('local_key').eq('connection_id', conn.id).eq('ref_type', 'file')
    if (doneErr) throw new Error(doneErr.message)
    const archived = new Set<string>((done || []).map((r: any) => r.local_key))

    let queued = 0, alreadyArchived = 0, capped = false
    for (const k of KINDS) {
      // Only the kinds this rule archives, and only ones this person is allowed to route.
      if (!(rule.event_types || []).includes(k.event) || !hasPermission(session, DRIVE_EVENT_PERMISSIONS[k.event] as any)) continue
      const { data: docs, error } = await service.from(k.table)
        .select('id, project_id, pdf_path').eq('workspace_id', session.workspaceId).eq('status', k.status)
        .not('pdf_path', 'is', null).neq('pdf_path', '').order(k.order, { ascending: false }).limit(BACKFILL_LIMIT)
      if (error) throw new Error(error.message)
      if ((docs || []).length >= BACKFILL_LIMIT) capped = true
      const todo = (docs || []).filter((d: any) => { const done_ = archived.has(`${k.type}:${d.id}`); if (done_) alreadyArchived++; return !done_ })
      if (!todo.length) continue

      const { data: events, error: evErr } = await service.from('integration_events').insert(todo.map((d: any) => ({
        workspace_id: session.workspaceId, event_type: k.event, entity_type: 'drive_backfill', entity_id: d.project_id, project_id: d.project_id,
        data: { document: { type: k.type, id: d.id }, title: 'Archive an earlier document', summary: 'Copying an already-executed document to Google Drive.', backfill: true },
      }))).select('id')
      if (evErr) throw new Error(evErr.message)
      const { error: delErr } = await service.from('integration_deliveries').insert((events || []).map((e: any) => ({ workspace_id: session.workspaceId, subscription_id: rule.id, event_id: e.id })))
      if (delErr) throw new Error(delErr.message)
      queued += (events || []).length
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.google_drive_backfill', entityType: 'integration_connection', entityId: conn.id, entityName: 'Google Drive',
      metadata: { queued, already_archived: alreadyArchived, capped },
    })
    return NextResponse.json({ queued, alreadyArchived, capped })
  } catch (err) {
    console.error('Google Drive backfill error:', err)
    return NextResponse.json({ error: 'Could not queue past documents. Please try again.' }, { status: 500 })
  }
}
