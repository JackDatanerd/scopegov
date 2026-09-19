// app/api/projects/[id]/members/route.ts  (NEW FILE — C14)

export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'ASSIGN_TEAM_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body = await request.json().catch(() => null)
    const memberId = body?.memberId
    if (!memberId || typeof memberId !== 'string') return NextResponse.json({ error: 'memberId required' }, { status: 400 })

    const service = createServiceClient()

    // Projects & Dashboard deep audit: this route (unlike members/available)
    // never checked that the CALLER can see the project. A custom role with
    // ASSIGN_TEAM_MEMBERS but only VIEW_OWN_PROJECTS could add themselves to
    // any project in the workspace and thereby grant themselves access.
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // FIX (audit round 2, item #6): projectId (from the URL) was never
    // checked against the caller's workspace — only memberId was. A
    // member of Workspace A could attach their own workspace_members row
    // to a project belonging to Workspace B, which then satisfied
    // canReadProject() for that foreign project (see fix in
    // lib/utils/project-access.ts). Verify the project up front.
    const { data: project } = await (service as any)
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('workspace_id', session.workspaceId)
      .is('deleted_at', null)
      .single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Verify the member belongs to this workspace
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id, users!workspace_members_user_id_fkey(name, email)')
      .eq('id', memberId)
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active')
      .single()

    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

    const { error } = await (service as any)
      .from('project_members')
      .upsert({
        project_id: projectId,
        member_id:  memberId,
        added_at:   new Date().toISOString(),
        added_by:   session.id,
      }, { onConflict: 'project_id,member_id' })

    if (error) throw new Error(error.message)

    // FIX (deep audit, section 7): every other project mutation
    // (create/update/delete/archive/complete, even SOW/CO actions) writes
    // an audit_log row — assigning or removing someone from a project
    // never did, leaving no record of team-composition changes at all.
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project_member.added', entityType: 'project',
      entityId: projectId, entityName: member.users?.name || member.users?.email || 'Unknown',
      metadata: { member_id: memberId },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}

// FIX (deep audit, section 7): there was no way to remove someone from a
// project once added — only POST (add) existed. An agency reorganizing
// staffing (someone rotates off a client engagement) had no path short of
// deactivating that person from the entire workspace.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'ASSIGN_TEAM_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body = await request.json().catch(() => null)
    const memberId = body?.memberId
    if (!memberId || typeof memberId !== 'string') return NextResponse.json({ error: 'memberId required' }, { status: 400 })

    const service = createServiceClient()

    // Same caller-can-see-the-project check as POST above.
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const { data: project } = await (service as any)
      .from('projects').select('id')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).is('deleted_at', null).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // FIX (deep audit, section 7): fetch who's being removed before the
    // delete, so the audit entry below can name them the same way the add
    // path does above.
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id, users!workspace_members_user_id_fkey(name, email)')
      .eq('id', memberId).eq('workspace_id', session.workspaceId).maybeSingle()

    // Read the result: the delete's error was ignored and a project.member
    // "removed" audit row was written even when nothing was removed.
    const { data: removed, error: delErr } = await (service as any)
      .from('project_members').delete()
      .eq('project_id', projectId).eq('member_id', memberId)
      .select('member_id')
    if (delErr) throw new Error(delErr.message)
    if (!removed || removed.length === 0)
      return NextResponse.json({ ok: true, removed: false })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project_member.removed', entityType: 'project',
      entityId: projectId, entityName: member?.users?.name || member?.users?.email || 'Unknown',
      metadata: { member_id: memberId },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
