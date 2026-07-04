// app/api/projects/[id]/members/available/route.ts  (NEW FILE — C14)
// Returns workspace members who are NOT already on this project.

export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    // Get member IDs already on the project
    const { data: existing } = await (service as any)
      .from('project_members')
      .select('workspace_member_id')
      .eq('project_id', projectId)

    const existingIds = (existing || []).map((e: any) => e.workspace_member_id)

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
