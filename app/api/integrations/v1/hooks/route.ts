export const runtime = 'nodejs'

import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey } from '@/lib/integrations/api-route'
import { encryptSecret, integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { generateSigningSecret } from '@/lib/integrations/signing'
import { INTEGRATION_EVENT_TYPES, permissionForEvent } from '@/lib/integrations/events'
import { EVENT_CATALOG } from '@/lib/integrations/event-catalog'
import { MAX_ZAPIER_HOOKS_PER_WORKSPACE, validateZapierTarget, keyCreatorHolds } from '@/lib/integrations/zapier'
import { logAudit } from '@/lib/utils/audit'

// Zapier "subscribe" (REST hook): { target_url, event } -> 201 { id }. Zapier calls this when a Zap using a ScopeGov
// trigger is turned on, and DELETE /hooks/{id} when it is turned off.
//
// Idempotent on (workspace, target_url): Zapier retries, and a repeated subscribe must not create a second hook (every
// event would then run the Zap twice). The signing secret is generated and stored but not returned — Zapier hooks are
// not verified by signature, the URL itself is the secret.
export async function POST(request: NextRequest) {
  try {
    const gate = await withApiKey(request)
    if ('response' in gate) return gate.response
    const { service, auth } = gate
    if (!integrationCryptoConfigured()) return NextResponse.json({ error: 'Integrations are not configured on this server.' }, { status: 503 })

    const body = await request.json().catch(() => null) as any
    const target = validateZapierTarget(body?.target_url)
    if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 })
    const event = String(body?.event ?? '')
    if (!INTEGRATION_EVENT_TYPES.includes(event)) return NextResponse.json({ error: `Unknown event: ${event || '(none)'}` }, { status: 400 })

    // The key must not reach beyond what the person who made it can see.
    if (!(await keyCreatorHolds(service, auth.workspaceId, auth.createdBy, permissionForEvent(event))))
      return NextResponse.json({ error: `The person who created this API key no longer has the ${permissionForEvent(event)} permission needed for ${event}.` }, { status: 403 })

    const { data: existing, error: findErr } = await service.from('integration_subscriptions')
      .select('id, active').eq('workspace_id', auth.workspaceId).eq('kind', 'zapier').eq('target_url', target.url).maybeSingle()
    if (findErr) throw new Error(findErr.message)
    if (existing) {
      const { error } = await service.from('integration_subscriptions')
        .update({ event_types: [event], active: true, consecutive_failures: 0, disabled_reason: null }).eq('id', existing.id)
      if (error) throw new Error(error.message)
      return NextResponse.json({ id: existing.id }, { status: 200 })
    }

    const { count, error: countErr } = await service.from('integration_subscriptions')
      .select('id', { count: 'exact', head: true }).eq('workspace_id', auth.workspaceId).eq('kind', 'zapier')
    if (countErr) throw new Error(countErr.message)
    if ((count ?? 0) >= MAX_ZAPIER_HOOKS_PER_WORKSPACE)
      return NextResponse.json({ error: `Too many active Zap triggers (limit ${MAX_ZAPIER_HOOKS_PER_WORKSPACE}). Turn some Zaps off.` }, { status: 409 })

    const id = randomUUID()
    const label = EVENT_CATALOG.find(e => e.type === event)?.label || event
    const { error } = await service.from('integration_subscriptions').insert({
      id, workspace_id: auth.workspaceId, kind: 'zapier', name: `Zapier · ${label}`, target_url: target.url, event_types: [event],
      secret_enc: encryptSecret(generateSigningSecret(), `${auth.workspaceId}:${id}`), created_by: auth.createdBy,
    })
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: auth.workspaceId, actorId: auth.createdBy, actorEmail: 'integrations@scopegov.app', actorName: 'Zapier (API key)',
      eventType: 'workspace.zapier_hook_created', entityType: 'integration_subscription', entityId: id, entityName: label,
      metadata: { event, keyId: auth.keyId }, omitClientIp: true,
    })
    return NextResponse.json({ id }, { status: 201 })
  } catch (err) {
    console.error('Zapier subscribe error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
