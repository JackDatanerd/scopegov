// FIX (deep audit, section 7): there was no way back from Archived — the
// only transition into it (POST .../archive) had no inverse, so a project
// archived by mistake, or one that needs to be reopened (e.g. a client
// returns with more work under the same engagement), was permanently
// stuck. Mirrors archive/route.ts's shape and permission.

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
    if (!hasPermission(session, 'MARK_PROJECT_COMPLETE'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { data: project } = await (service as any)
      .from('projects').select('id,name,status').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (project.status !== 'Archived')
      return NextResponse.json({ error: 'Only Archived projects can be unarchived' }, { status: 400 })

    const now = new Date().toISOString()
    await (service as any).from('projects').update({ status: 'Complete', updated_at: now }).eq('id', id)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.unarchived', entityType: 'project',
      entityId: id, entityName: project.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
