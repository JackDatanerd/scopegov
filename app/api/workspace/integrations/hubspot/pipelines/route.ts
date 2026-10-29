export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { hubspotAs, loadHubspotConnection } from '@/lib/integrations/hubspot-connection'
import { stagesOf } from '@/lib/integrations/hubspot'

// The deal pipelines in the connected HubSpot account that can be used for the sync (those with both a Closed-won and a Closed-lost stage).
export async function GET() {
  try {
    const auth = await requireIntegrationAdmin('hubspot')
    if ('response' in auth) return auth.response
    const service = createServiceClient() as any
    const conn = await loadHubspotConnection(service, auth.session.workspaceId)
    if (!conn || conn.status !== 'active') return NextResponse.json({ error: 'HubSpot is not connected.', reconnect: conn?.status === 'error' }, { status: 409 })
    const r = await hubspotAs(service, conn, 'GET', '/crm/v3/pipelines/deals')
    if (!r.ok) return NextResponse.json({ error: r.error, reconnect: r.reconnect }, { status: r.reconnect ? 409 : 502 })
    const pipelines = (r.json?.results || []).map((p: any) => ({ ...stagesOf(p) })).filter((p: any) => p.won && p.lost).map((p: any) => ({ id: p.id, label: p.label }))
    return NextResponse.json({ pipelines })
  } catch (err) {
    console.error('HubSpot pipelines error:', err)
    return NextResponse.json({ error: 'Could not load HubSpot pipelines. Please try again.' }, { status: 500 })
  }
}
