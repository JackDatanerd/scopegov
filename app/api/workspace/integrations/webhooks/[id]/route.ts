export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { logAudit } from '@/lib/utils/audit'
import { isUuidString as isUuid } from '@/lib/utils/uuid'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { encryptSecret, integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { generateSigningSecret } from '@/lib/integrations/signing'
import { validateWebhookUrl } from '@/lib/integrations/url'
import { parseEventTypes } from '@/lib/integrations/event-input'
import { eventsBeyondPermissions } from '@/lib/integrations/events'
import { hasPermission } from '@/lib/auth/session'

type Ctx = { params: Promise<{ id: string }> }

// Edit a webhook: name, URL, events, on/off, or `rotateSecret: true` (returns the new secret once).
// Turning a webhook back ON clears its failure streak so it is not switched straight off again.
export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const auth = await requireIntegrationAdmin('webhook')
    if ('response' in auth) return auth.response
    const { session } = auth

    const body = await request.json().catch(() => null) as any
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = sanitizeDisplayName(String(body.name)).trim()
      if (!name || name.length > 80) return NextResponse.json({ error: 'Give the webhook a name (up to 80 characters).' }, { status: 400 })
      patch.name = name
    }
    if (body.url !== undefined) {
      const url = validateWebhookUrl(body.url)
      if (!url.ok) return NextResponse.json({ error: url.error }, { status: 400 })
      patch.target_url = url.url
    }
    if (body.events !== undefined) {
      const events = parseEventTypes(body.events)
      if (!events.ok) return NextResponse.json({ error: events.error }, { status: 400 })
      const beyond = eventsBeyondPermissions(events.types, p => hasPermission(session, p as any))
      if (beyond.length) return NextResponse.json({ error: `You need more permissions to subscribe to: ${beyond.join(', ')}` }, { status: 403 })
      patch.event_types = events.types
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      patch.active = body.active
      if (body.active) Object.assign(patch, { consecutive_failures: 0, disabled_reason: null })
    }
    const rotate = body.rotateSecret === true
    // Re-pointing a webhook at a different URL, or replacing its secret, are the two changes that could redirect
    // signed event data somewhere new: require a recent re-authentication for them.
    if (rotate || patch.target_url !== undefined) {
      const stepUp = await requireStepUpForCurrentUser()
      if (stepUp) return stepUp
    }
    let secret: string | undefined
    if (rotate) {
      if (!integrationCryptoConfigured()) return NextResponse.json({ error: 'Integrations are not configured on this server yet.' }, { status: 503 })
      secret = generateSigningSecret()
      patch.secret_enc = encryptSecret(secret, `${session.workspaceId}:${id}`)
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

    const service = createServiceClient() as any
    // A Zapier-managed hook can only be switched on/off here (Zapier owns its URL and events); everything else is for
    // customer webhooks.
    const onlyToggle = Object.keys(patch).every(k => ['active', 'consecutive_failures', 'disabled_reason'].includes(k))
    let q = service.from('integration_subscriptions').update(patch).eq('id', id).eq('workspace_id', session.workspaceId)
    if (!onlyToggle) q = q.eq('kind', 'webhook')
    const { data, error } = await q.select('id, name').maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: rotate ? 'workspace.webhook_secret_rotated' : 'workspace.webhook_updated', entityType: 'integration_subscription', entityId: id, entityName: data.name,
      metadata: { changed: Object.keys(patch).filter(k => k !== 'secret_enc') },
    })
    return NextResponse.json(secret ? { ok: true, secret } : { ok: true })
  } catch (err) {
    console.error('Webhook update error:', err)
    return NextResponse.json({ error: 'Could not update the webhook. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const auth = await requireIntegrationAdmin('webhook')
    if ('response' in auth) return auth.response
    const { session } = auth

    const service = createServiceClient() as any
    const { data, error } = await service.from('integration_subscriptions').delete()
      .eq('id', id).eq('workspace_id', session.workspaceId).select('id, name').maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.webhook_deleted', entityType: 'integration_subscription', entityId: id, entityName: data.name,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Webhook delete error:', err)
    return NextResponse.json({ error: 'Could not delete the webhook. Please try again.' }, { status: 500 })
  }
}
