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
    // FIX (re-audit, notifications section): the bell's unread badge used
    // to be derived from this same 50-row list (items.filter(!read).length
    // client-side) — for anyone who accumulates more than 50 unread
    // notifications, anything older than the 50 most recent was never
    // fetched at all, so the badge silently undercounted and those older
    // notifications were permanently unreachable via the bell (only
    // "mark all read" — a separate, unlimited server-side update — ever
    // touched them). A dedicated count query, unbounded by the list limit,
    // fixes the badge; the list itself staying capped at 50 is a
    // reasonable scope call, but the count it displays shouldn't lie.
    const { count: unreadCount } = await (service as any)
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId)
      .eq('recipient_id', session.id)
      .eq('read', false)
    return NextResponse.json({ notifications: notifications || [], unreadCount: unreadCount || 0 })
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
