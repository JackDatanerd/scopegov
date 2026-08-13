import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const { projectId, deliverable, oldValue, newValue, reason } = await request.json()
    if (!projectId || !deliverable || !newValue || !reason?.trim())
      return NextResponse.json({ error: 'deliverable, newValue, and reason are required' }, { status: 400 })

    const service = createServiceClient()

    // Verify project
    const { data: project } = await (service as any)
      .from('projects').select('id,name').eq('id', projectId)
      .eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const now = new Date().toISOString()

    // Spec §1.6.7: scope_adjustments record + synchronous row-locked snapshot write
    // + Activity entry — all in one transaction (best-effort sequential here)
    const { data: adjustment, error: adjErr } = await (service as any)
      .from('scope_adjustments').insert({
        project_id:   projectId,
        workspace_id: session.workspaceId,
        deliverable,
        old_value:    oldValue || '',
        new_value:    newValue,
        reason:       reason.trim(),
        adjusted_by:  session.id,
      }).select('id').single()

    if (adjErr) throw new Error(adjErr.message)

    // Update scope snapshot — replace the matching deliverable
    const { data: snap } = await (service as any)
      .from('project_scope_snapshot').select('id,deliverables').eq('project_id', projectId).single()

    if (snap) {
      const deliverables = (snap.deliverables || []).map((d: any) =>
        (d.title === deliverable || d === deliverable) ? { title: newValue } : d
      )
      await (service as any).from('project_scope_snapshot').update({
        deliverables,
        last_updated_at: now,
        last_updated_by: 'scope_adjustment',
      }).eq('project_id', projectId)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.scope_adjustment_made', entityType: 'project',
      entityId: projectId, entityName: project.name,
      metadata: { deliverable, old_value: oldValue, new_value: newValue, reason },
    })

    return NextResponse.json({ ok: true, adjustmentId: adjustment.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
