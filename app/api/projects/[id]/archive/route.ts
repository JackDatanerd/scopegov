import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // Reuses MARK_PROJECT_COMPLETE — archiving is the next step in the same
    // project-closeout lifecycle, not a distinct permission concern.
    if (!hasPermission(session, 'MARK_PROJECT_COMPLETE'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    // FIX (deep audit, section 7): same gap as complete/route.ts — added
    // the same canReadProject check so a narrowly-scoped custom role can't
    // archive a project it can't otherwise see.
    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { data: project } = await (service as any)
      .from('projects').select('id,name,status').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // Archived is already a valid value in the project_status enum, but
    // only reachable from Complete — matches the intended lifecycle
    // (Draft → ... → Active → Complete → Archived) and avoids skipping
    // the completion checks (blocking COs, open flags) that Complete enforces.
    if (project.status !== 'Complete')
      return NextResponse.json({ error: 'Only Complete projects can be archived' }, { status: 400 })

    const now = new Date().toISOString()
    await (service as any).from('projects').update({ status: 'Archived', updated_at: now }).eq('id', id)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.archived', entityType: 'project',
      entityId: id, entityName: project.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
