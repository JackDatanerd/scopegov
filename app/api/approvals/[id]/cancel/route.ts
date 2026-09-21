export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { cancelApprovalRequest } from '@/lib/approvals/engine'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: req } = await (service as any)
      .from('approval_requests')
      .select('id, requested_by, status, document_type, document_id, project_id, send_failed_at, sending_started_at')
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!req) return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
    // FIX (section-11 audit, pass 2): cancelApprovalRequest() has handled the
    // "approved but the send failed" state since migration 053, but this route
    // still refused anything that wasn't 'pending' — so a request stuck there
    // (client email missing, project reopened later, …) could be neither retried
    // to success nor abandoned, while the edit-lock froze the document. For a
    // draft SOW there was no other way out at all (no delete/void route).
    const sendFailed = req.status === 'approved' && !!req.send_failed_at
    if (req.status !== 'pending' && !sendFailed)
      return NextResponse.json({ error: 'Only a pending or approved-but-unsent request can be cancelled' }, { status: 400 })
    // The last step cleared and the send is running right now — cancelling would
    // race a document that is about to go out. (A send that died mid-flight is
    // healed into the retryable state by the stall cron within minutes.)
    if (req.status === 'pending' && req.sending_started_at &&
        Date.now() - new Date(req.sending_started_at).getTime() < 2 * 60 * 1000)
      return NextResponse.json({ error: 'This request was just approved and is being sent — give it a moment, then refresh.' }, { status: 409 })
    if (req.requested_by !== session.id && !hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Only the requester or an admin can cancel this' }, { status: 403 })
    // FIX (fix round, section-11 finding): recordApprovalDecision treats
    // canReadProject as the actual authorization boundary for approve/
    // reject specifically because MANAGE_WORKSPACE_SETTINGS is a workspace-
    // wide admin permission, not project visibility (see that function's
    // own comment) — a member can hold it without VIEW_ALL_PROJECTS or any
    // assignment to this particular project. This route's admin-override
    // branch above never enforced that same boundary, so a project-
    // restricted admin could cancel a request for a project they have no
    // other visibility into. Mirrors the decision path's own check exactly.
    if (!(await canReadProject(service, session, req.project_id)))
      return NextResponse.json({ error: 'You do not have access to this project' }, { status: 403 })

    // FIX (section-11 audit): this reason was hardcoded regardless of who
    // actually cancelled it — an admin using the MANAGE_WORKSPACE_SETTINGS
    // override above to cancel someone else's request got the exact same
    // audit-log text as the requester cancelling their own, making the
    // audit trail actively misleading about who acted.
    await cancelApprovalRequest(service, {
      documentType: req.document_type, documentId: req.document_id,
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: (sendFailed ? 'Abandoned after a failed send — ' : '') + (req.requested_by === session.id ? 'Cancelled by requester' : 'Cancelled by admin'),
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Approval cancel error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
