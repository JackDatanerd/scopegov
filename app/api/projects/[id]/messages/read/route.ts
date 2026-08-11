// app/api/projects/[id]/messages/read/route.ts
//
// Sets the caller's read high-water-mark for a project's discussion to
// now. Called when the Discussion tab is opened (see
// components/projects/ProjectDiscussion.tsx) — same idea as
// NotificationBell's mark-read, just scoped to one project's feed
// instead of the global notification list.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(
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

    const { error } = await (service as any)
      .from('project_message_reads')
      .upsert(
        { project_id: projectId, user_id: session.id, last_read_at: new Date().toISOString() },
        { onConflict: 'project_id,user_id' }
      )

    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
