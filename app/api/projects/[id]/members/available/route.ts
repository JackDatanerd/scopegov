// app/api/projects/[id]/members/available/route.ts  (NEW FILE — C14)
// Returns workspace members who are NOT already on this project.

export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    // FIX (deep audit, section 7): this had no permission or project-
    // visibility check at all beyond "is logged in" — unlike POST on the
    // sibling route (ASSIGN_TEAM_MEMBERS + a verified project). In
    // practice this doesn't leak anything the Team page doesn't already
    // show any authenticated member, but it's the only endpoint in this
    // whole section that skipped both checks. Bring it in line.
    if (!hasPermission(session, 'ASSIGN_TEAM_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    // Soft-deleted projects are not assignable.
    const { data: live } = await (service as any).from('projects').select('id')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).is('deleted_at', null).maybeSingle()
    if (!live) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Get member IDs already on the project
    const { data: existing } = await (service as any)
      .from('project_members')
      .select('member_id')
      .eq('project_id', projectId)

    const existingIds = (existing || []).map((e: any) => e.member_id)

    // Get all active workspace members not already assigned
    let query = (service as any)
      .from('workspace_members')
      .select('id, users!workspace_members_user_id_fkey(id, name, email, avatar_url), roles(name)')
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active')

    if (existingIds.length > 0) {
      query = query.not('id', 'in', `(${existingIds.join(',')})`)
    }

    const { data: members, error } = await query
    if (error) throw new Error(error.message)

    return NextResponse.json({ members: members || [] })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
