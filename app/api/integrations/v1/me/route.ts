export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey } from '@/lib/integrations/api-route'

// Authentication check for API-key clients (Zapier's "test your connection" call). Answers who the key belongs to
// and nothing else. Every failure is the same 401 so a probe learns nothing about which keys exist.
export async function GET(request: NextRequest) {
  try {
    const gate = await withApiKey(request)
    if ('response' in gate) return gate.response
    const { service, auth } = gate
    const { data: ws } = await service.from('workspaces').select('id, name, agency_name').eq('id', auth.workspaceId).maybeSingle()
    return NextResponse.json({ workspace: { id: auth.workspaceId, name: ws?.agency_name || ws?.name || '' } })
  } catch (err) {
    console.error('Integrations /me error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
