import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const { workspaceId, revisionRounds, paymentStructure, governingLaw } = await request.json()
    const wsId   = workspaceId || session.workspaceId
    const service = createServiceClient()

    await (service as any).from('workspace_defaults').upsert({
      workspace_id:      wsId,
      project_type:      null, // null = global default
      revision_rounds:   revisionRounds || 2,
      payment_structure: paymentStructure || '50_50',
      governing_law:     governingLaw || 'Republic of Kenya',
      updated_at:        new Date().toISOString(),
    }, { onConflict: 'workspace_id,project_type' })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  return POST(request)
}
