import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

// Complete -> Archived.
// The status update is guarded on the status we validated and its `{ error }`
// is checked — it used to be fire-and-forget, so a failed write still
// returned { ok: true } and logged an audit event for a change that never
// happened. Soft-deleted projects are treated as not found.
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
      .from('projects').select('id,name,status').eq('id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null).maybeSingle()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (project.status !== 'Complete')
      return NextResponse.json({ error: 'Only Complete projects can be archived' }, { status: 400 })

    const now = new Date().toISOString()
    const { data: moved, error: moveErr } = await (service as any).from('projects')
      .update({ status: 'Archived', updated_at: now })
      .eq('id', id).eq('workspace_id', session.workspaceId).eq('status', 'Complete').is('deleted_at', null)
      .select('id')
    if (moveErr) {
      console.error('Project archive error:', moveErr)
      return NextResponse.json({ error: 'Could not archive the project' }, { status: 500 })
    }
    if (!moved || moved.length === 0)
      return NextResponse.json({ error: 'This project changed. Refresh and try again.' }, { status: 409 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.archived', entityType: 'project',
      entityId: id, entityName: project.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Project archive error:', err)
    return NextResponse.json({ error: 'Could not archive the project' }, { status: 500 })
  }
}
