// app/api/projects/[id]/messages/unread-count/route.ts
//
// Lightweight count for the Discussion tab's badge — fetched once on
// ProjectDetail mount, independent of actually opening the tab (mirrors
// how the Guardian tab's badge is derived from data the page already
// has; the discussion feed isn't preloaded server-side, so this is a
// small dedicated round trip instead).

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: readRow } = await (service as any)
      .from('project_message_reads')
      .select('last_read_at')
      .eq('project_id', projectId)
      .eq('user_id', session.id)
      .maybeSingle()

    let query = (service as any)
      .from('project_messages')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .is('deleted_at', null)
      // Never count the viewer's own messages as "unread" for them.
      .neq('author_id', session.id)

    if (readRow?.last_read_at) query = query.gt('created_at', readRow.last_read_at)

    const { count } = await query
    return NextResponse.json({ count: count || 0 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
