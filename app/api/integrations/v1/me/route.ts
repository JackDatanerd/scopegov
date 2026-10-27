export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { authenticateApiKey } from '@/lib/integrations/api-keys'

// Authentication check for API-key clients (Zapier's "test your connection" call). Answers who the key belongs to
// and nothing else. Every failure is the same 401 so a probe learns nothing about which keys exist.
export async function GET(request: NextRequest) {
  try {
    const service = createServiceClient() as any
    const auth = await authenticateApiKey(service, request.headers.get('authorization'))
    if (!auth) return NextResponse.json({ error: 'Invalid API key' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
    const { data: ws } = await service.from('workspaces').select('id, name, agency_name').eq('id', auth.workspaceId).maybeSingle()
    return NextResponse.json({ workspace: { id: auth.workspaceId, name: ws?.agency_name || ws?.name || '' } })
  } catch (err) {
    console.error('Integrations /me error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
