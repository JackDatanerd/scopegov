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

    // Mark read UP TO what the client actually displayed (`upTo`), never past
    // it: stamping "now" marked messages that arrived between the feed fetch
    // and this call as read even though the person never saw them. The
    // marker only ever moves forward.
    const body = await request.json().catch(() => ({}))
    const nowMs = Date.now()
    let target = nowMs
    if (typeof body?.upTo === 'string') {
      const t = new Date(body.upTo).getTime()
      if (!Number.isNaN(t)) target = Math.min(t, nowMs)
    }
    const { data: existing } = await (service as any)
      .from('project_message_reads')
      .select('last_read_at')
      .eq('project_id', projectId).eq('user_id', session.id).maybeSingle()
    const existingMs = existing?.last_read_at ? new Date(existing.last_read_at).getTime() : 0
    // Keep the exact timestamp string the client echoed back (it carries the
    // database's microseconds); only fall back to a JS date for the "now" case.
    const stamp = typeof body?.upTo === 'string' && target !== nowMs ? body.upTo : new Date(target).toISOString()
    if (target <= existingMs) return NextResponse.json({ ok: true })

    const { error } = await (service as any)
      .from('project_message_reads')
      .upsert(
        { project_id: projectId, user_id: session.id, last_read_at: stamp },
        { onConflict: 'project_id,user_id' }
      )

    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('projects/[id]/messages/read error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
