export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { reassignApprovalStep } from '@/lib/approvals/engine'
import { canReadProject } from '@/lib/utils/project-access'

// FEATURE (section-11 audit, pass 2): hand the CURRENT step of a pending
// request to a different person or role. Steps are snapshots of the workflow
// taken when the request was raised, so editing the workflow never rescued a
// request whose approver had left, was away, or turned out to be the requester
// — the only way out was cancel and resubmit. Workspace admins only.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Only a workspace admin can reassign an approval step' }, { status: 403 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const userId = typeof body.userId === 'string' && body.userId ? body.userId : null
    const roleId = typeof body.roleId === 'string' && body.roleId ? body.roleId : null
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length > 500)
      return NextResponse.json({ error: 'Please keep the reason under 500 characters' }, { status: 400 })

    const service = createServiceClient()
    const { data: req } = await (service as any)
      .from('approval_requests').select('id, project_id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!req) return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
    // MANAGE_WORKSPACE_SETTINGS is a workspace-wide admin permission, not
    // project visibility — same boundary as cancel/retry-send.
    if (!(await canReadProject(service, session, req.project_id)))
      return NextResponse.json({ error: 'You do not have access to this project' }, { status: 403 })

    const result = await reassignApprovalStep(service, {
      requestId: id, workspaceId: session.workspaceId,
      actor: { id: session.id, name: session.name, email: session.email },
      target: { userId, roleId }, reason: reason || null,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Approval reassign error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
