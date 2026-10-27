export const runtime = 'nodejs'

import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { MAX_SUBSCRIPTIONS_PER_WORKSPACE } from '@/lib/integrations/plans'
import { encryptSecret, integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { generateSigningSecret } from '@/lib/integrations/signing'
import { validateWebhookUrl } from '@/lib/integrations/url'
import { parseEventTypes } from '@/lib/integrations/event-input'
import { eventsBeyondPermissions } from '@/lib/integrations/events'
import { hasPermission } from '@/lib/auth/session'

// Creates a webhook. The signing secret is generated here, stored ENCRYPTED, and returned exactly once in this
// response — it is never readable again (rotate it to get a new one).
export async function POST(request: NextRequest) {
  try {
    const auth = await requireIntegrationAdmin('webhook')
    if ('response' in auth) return auth.response
    const { session } = auth
    if (!integrationCryptoConfigured())
      return NextResponse.json({ error: 'Integrations are not configured on this server yet (INTEGRATIONS_ENCRYPTION_KEY).' }, { status: 503 })

    const body = await request.json().catch(() => null) as any
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const name = sanitizeDisplayName(String(body.name ?? '')).trim()
    if (!name || name.length > 80) return NextResponse.json({ error: 'Give the webhook a name (up to 80 characters).' }, { status: 400 })
    const url = validateWebhookUrl(body.url)
    if (!url.ok) return NextResponse.json({ error: url.error }, { status: 400 })
    const events = parseEventTypes(body.events)
    if (!events.ok) return NextResponse.json({ error: events.error }, { status: 400 })
    // You can only subscribe to events you could see yourself (see permissionForEvent).
    const beyond = eventsBeyondPermissions(events.types, p => hasPermission(session, p as any))
    if (beyond.length) return NextResponse.json({ error: `You need more permissions to subscribe to: ${beyond.join(', ')}` }, { status: 403 })

    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp

    const service = createServiceClient() as any
    const { count, error: countErr } = await service.from('integration_subscriptions')
      .select('id', { count: 'exact', head: true }).eq('workspace_id', session.workspaceId).eq('kind', 'webhook')
    if (countErr) throw new Error(countErr.message)
    if ((count ?? 0) >= MAX_SUBSCRIPTIONS_PER_WORKSPACE)
      return NextResponse.json({ error: `A workspace can have up to ${MAX_SUBSCRIPTIONS_PER_WORKSPACE} webhooks. Remove one first.` }, { status: 409 })

    const id = randomUUID()
    const secret = generateSigningSecret()
    const { error } = await service.from('integration_subscriptions').insert({
      id, workspace_id: session.workspaceId, kind: 'webhook', name, target_url: url.url, event_types: events.types,
      secret_enc: encryptSecret(secret, `${session.workspaceId}:${id}`), created_by: session.id,
    })
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.webhook_created', entityType: 'integration_subscription', entityId: id, entityName: name,
      metadata: { events: events.types, host: new URL(url.url).hostname },
    })
    return NextResponse.json({ id, secret }, { status: 201 })
  } catch (err) {
    console.error('Webhook create error:', err)
    return NextResponse.json({ error: 'Could not create the webhook. Please try again.' }, { status: 500 })
  }
}
