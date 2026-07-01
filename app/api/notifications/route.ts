import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    const { data: notifications } = await (service as any)
      .from('notifications')
      .select('*')
      .eq('workspace_id', session.workspaceId)
      .eq('recipient_id', session.id)
      .order('created_at', { ascending: false })
      .limit(50)
    return NextResponse.json({ notifications: notifications || [] })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { ids, all } = await request.json()
    const service = createServiceClient()
    const now     = new Date().toISOString()
    let q = (service as any).from('notifications')
      .update({ read: true, read_at: now })
      .eq('workspace_id', session.workspaceId)
      .eq('recipient_id', session.id)
    if (!all && ids?.length) q = q.in('id', ids)
    await q
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}
