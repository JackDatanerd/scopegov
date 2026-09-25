import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { listMentionable } from '@/lib/utils/project-messages'

// GET /api/projects/[id]/messages/mentionable — everyone who can be @-mentioned in this project's
// discussion: its team plus everyone who can see every project. Same list the POST/PATCH routes validate
// mentions against, so the picker can't offer someone the server would then refuse.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const people = await listMentionable(service, session.workspaceId, projectId)
    return NextResponse.json({
      members: people.filter(p => p.id !== session.id).map(p => ({ id: p.id, name: p.name, avatarUrl: p.avatarUrl })),
    })
  } catch (err) {
    console.error('Project mentionable error:', err)
    return NextResponse.json({ error: 'Could not load people' }, { status: 500 })
  }
}
