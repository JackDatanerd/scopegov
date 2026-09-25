import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { loadProjectActivity } from '@/lib/utils/project-activity'

// GET /api/projects/[id]/activity?offset=50 — older activity for the project's Activity tab.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const raw = Number(new URL(request.url).searchParams.get('offset') || 0)
    const offset = Number.isInteger(raw) && raw >= 0 && raw <= 100000 ? raw : 0

    const result = await loadProjectActivity(service, session.workspaceId, id, hasPermission(session, 'VIEW_FINANCIALS'), offset)
    return NextResponse.json(result)
  } catch (err) {
    console.error('Project activity error:', err)
    return NextResponse.json({ error: 'Could not load activity' }, { status: 500 })
  }
}
