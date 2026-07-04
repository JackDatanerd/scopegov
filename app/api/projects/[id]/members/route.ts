// app/api/projects/[id]/members/route.ts  (NEW FILE — C14)

export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS') && !hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const { memberId } = await request.json()
    if (!memberId) return NextResponse.json({ error: 'memberId required' }, { status: 400 })

    const service = createServiceClient()

    // Verify the member belongs to this workspace
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id')
      .eq('id', memberId)
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active')
      .single()

    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

    const { error } = await (service as any)
      .from('project_members')
      .upsert({
        project_id:          projectId,
        workspace_member_id: memberId,
        added_at:            new Date().toISOString(),
        added_by:            session.id,
      }, { onConflict: 'project_id,workspace_member_id' })

    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
