export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isUuidString as isUuid } from '@/lib/utils/uuid'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'

// "Send test event": queues one `integration.test` delivery for THIS webhook only (not fanned out to others). It
// goes through the same queue, signing and retry path as a real event, and is delivered by the next cron tick
// (within about a minute) — so a passing test proves the real pipeline, not a shortcut.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const auth = await requireIntegrationAdmin('webhook')
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any
    const { data, error } = await service.rpc('enqueue_integration_test', {
      p_subscription_id: id, p_workspace_id: session.workspaceId,
      p_data: { message: 'This is a test event from ScopeGov.', sent_by: session.name },
    })
    if (error) throw new Error(error.message)
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true, eventId: data })
  } catch (err) {
    console.error('Webhook test error:', err)
    return NextResponse.json({ error: 'Could not queue the test event. Please try again.' }, { status: 500 })
  }
}
