export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isUuidString } from '@/lib/utils/uuid'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'

// "Send test message": queues one test event for THIS rule only. It travels the real queue (so a passing test proves the
// token, the channel and the worker), and arrives within about a minute.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const auth = await requireIntegrationAdmin('slack')
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any
    const { data: row } = await service.from('integration_subscriptions').select('kind').eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (!row || row.kind !== 'slack') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const { data, error } = await service.rpc('enqueue_integration_test', {
      p_subscription_id: id, p_workspace_id: session.workspaceId,
      p_data: { message: 'This is a test message from ScopeGov. If you can read this, the connection works.', sent_by: session.name },
    })
    if (error) throw new Error(error.message)
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Slack test error:', err)
    return NextResponse.json({ error: 'Could not queue the test message. Please try again.' }, { status: 500 })
  }
}
