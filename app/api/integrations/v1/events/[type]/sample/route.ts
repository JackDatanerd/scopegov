export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey } from '@/lib/integrations/api-route'
import { EVENT_CATALOG, sampleEnvelope } from '@/lib/integrations/event-catalog'
import { permissionForEvent } from '@/lib/integrations/events'
import { keyCreatorHolds } from '@/lib/integrations/zapier'

// Sample data for a Zapier trigger (Zapier needs a realistic example to let people map fields before any real event
// exists). A static example in the exact shape of a delivery — never real client data, so it needs no permission beyond
// the key itself, but the same permission rule as subscribing applies so the trigger list is not a way to probe.
export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  try {
    const gate = await withApiKey(request)
    if ('response' in gate) return gate.response
    const { type } = await params
    const info = EVENT_CATALOG.find(e => e.type === type)
    if (!info) return NextResponse.json({ error: 'Unknown event' }, { status: 404 })
    if (!(await keyCreatorHolds(gate.service, gate.auth.workspaceId, gate.auth.createdBy, permissionForEvent(type))))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json([sampleEnvelope(info)])
  } catch (err) {
    console.error('Zapier sample error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
