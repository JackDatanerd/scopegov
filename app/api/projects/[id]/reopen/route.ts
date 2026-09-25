import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { wouldExceedLimit, isOverLimit, projectLimitMessage } from '@/lib/utils/project-limit'

// Complete -> Active (undo an accidental "Mark complete"). FEATURE (Projects deep audit): the only way back from Complete used to be the PATCH status hole, so a mis-click could not be undone. Archived projects go through unarchive first.
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
      return NextResponse.json({ error: 'Only Complete projects can be reopened (unarchive an archived project first)' }, { status: 400 })

    // Complete projects don't count toward the plan's active-project allowance; Active ones do. Reopening
    // used to skip this check entirely, so create-2 / complete-1 / create-1 / reopen-1 ran a Solo
    // workspace at 3 live projects.
    if (await wouldExceedLimit(service, session.workspaceId, session.planTier))
      return NextResponse.json({ error: projectLimitMessage(session.planTier, 'reopen') }, { status: 403 })

    const now = new Date().toISOString()
    const { data: moved, error: moveErr } = await (service as any).from('projects')
      .update({ status: 'Active', updated_at: now })
      .eq('id', id).eq('workspace_id', session.workspaceId).eq('status', 'Complete').is('deleted_at', null)
      .select('id')
    if (moveErr) {
      console.error('Project reopen error:', moveErr)
      return NextResponse.json({ error: 'Could not reopen the project' }, { status: 500 })
    }
    if (!moved || moved.length === 0)
      return NextResponse.json({ error: 'This project changed. Refresh and try again.' }, { status: 409 })

    // Lost the count-then-write race to a concurrent create/reopen: put it back (guarded on the status
    // we just wrote so a later legitimate change isn't clobbered).
    if (await isOverLimit(service, session.workspaceId, session.planTier)) {
      await (service as any).from('projects')
        .update({ status: 'Complete', updated_at: new Date().toISOString() })
        .eq('id', id).eq('workspace_id', session.workspaceId).eq('status', 'Active')
      return NextResponse.json({ error: projectLimitMessage(session.planTier, 'reopen') }, { status: 403 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.reopened', entityType: 'project',
      entityId: id, entityName: project.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Project reopen error:', err)
    return NextResponse.json({ error: 'Could not reopen the project' }, { status: 500 })
  }
}
