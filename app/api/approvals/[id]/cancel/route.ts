export const runtime = 'nodejs'

import { isUuidString } from '@/lib/utils/uuid'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { cancelApprovalRequest } from '@/lib/approvals/engine'
import { isSendClaimLive } from '@/lib/approvals/send-claim'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const service = createServiceClient()
    // FIX (approvals pass 14): .single() + an unread `error` answered 404 "not found" for a transient read failure.
    const { data: req, error: reqErr } = await (service as any)
      .from('approval_requests')
      .select('id, requested_by, status, document_type, document_id, project_id, send_failed_at, sending_started_at')
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()
    if (reqErr) {
      console.error('Approval cancel: request lookup failed:', reqErr)
      return NextResponse.json({ error: 'Could not load this approval request — please try again.' }, { status: 500 })
    }

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
    //
    // FIX (section-11 audit): this only checked status==='pending', which is the
    // original auto-send's claim state. retryFailedSend claims the SAME way but
    // stays status==='approved' the whole time (send_failed_at isn't cleared until
    // the retry finishes) — so this let a cancel land while a retry's email was
    // actually going out, then leave the request 'cancelled' with no status guard
    // on retryFailedSend's own success write to catch it. Cover both claim states.
    if (isSendClaimLive(req.sending_started_at))
      return NextResponse.json({ error: 'This request is being sent right now — give it a moment, then refresh.' }, { status: 409 })
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
    // FIX (approvals pass 13): the requester is exempt. This check exists for the admin-override branch (a workspace-wide
    // MANAGE_WORKSPACE_SETTINGS holder is not project visibility); applying it to the requester too meant someone who
    // lost access to the project could not abandon their own request — which edit-locks the document — and an admin
    // had to do it for them. Cancelling touches no project data the requester has not already been party to.
    if (req.requested_by !== session.id && !(await canReadProject(service, session, req.project_id)))
      return NextResponse.json({ error: 'You do not have access to this project' }, { status: 403 })

    // FIX (section-11 audit): this reason was hardcoded regardless of who
    // actually cancelled it — an admin using the MANAGE_WORKSPACE_SETTINGS
    // override above to cancel someone else's request got the exact same
    // audit-log text as the requester cancelling their own, making the
    // audit trail actively misleading about who acted.
    // FIX (approvals pass 14): "it is now an editable draft again" was claimed for every non-counter cancel. After a send
    // that died mid-flight is healed into "approved — not sent", the document may in fact have gone out (the heal reason
    // says so): a SOW that is 'awaiting_signature' is not an editable draft. Only claim it when the document still is one.
    let returnedToDraft = req.document_type !== 'co_counter'
    // (approvals pass 15, B2) A request still 'pending' whose send claim went stale (the process died mid-send) can
    // equally have delivered the document before dying, so any request that ever stamped a claim needs the real check.
    if (returnedToDraft && (sendFailed || !!req.sending_started_at)) {
      const table = req.document_type === 'sow' ? 'sow_documents' : req.document_type === 'invoice' ? 'invoices' : 'change_orders'
      const { data: doc, error: docErr } = await (service as any)
        .from(table).select('status').eq('id', req.document_id).eq('workspace_id', session.workspaceId).maybeSingle()
      if (docErr) console.error('Approval cancel: could not read the document status:', docErr)
      returnedToDraft = !docErr && doc?.status === 'draft'
    }

    const cancelResult = await cancelApprovalRequest(service, {
      documentType: req.document_type, documentId: req.document_id,
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: (sendFailed ? 'Abandoned after a failed send — ' : '') + (req.requested_by === session.id ? 'Cancelled by requester' : 'Cancelled by admin'),
      // FIX (section-11/12 fix round): this was hardcoded true regardless of
      // document_type. A sow/co/invoice gate genuinely leaves the document at
      // status:'draft' the whole time it's pending, so "editable draft again" is
      // accurate for those — but a co_counter gate (accepting a client's counter-
      // offer) leaves the underlying CO at status:'countered' the whole time (see
      // accept-co-counter.ts, which never touches status until the approval
      // clears). Cancelling one of those doesn't return anything to draft — the
      // CO just stays 'countered', still awaiting the agency's decision — so the
      // notification text this drives must not claim it does.
      returnedToDraft,
    })

    // FIX (section-11 independent pass 9, B1): the result was ignored, so this answered { ok: true } even when
    // nothing was cancelled. The pre-checks above read the row BEFORE the write; the last approver can clear the
    // final step in between, which stamps the send claim — cancelApprovalRequest then (correctly) refuses and
    // returns { cancelled: false, blockedBySend: true }, but the requester was told "cancelled / back to draft"
    // while the document was in fact going out to the client. Same for a request that was decided or cancelled by
    // someone else in the gap. Report what actually happened.
    if (!cancelResult.cancelled) {
      if (cancelResult.blockedBySend)
        return NextResponse.json({ error: 'This request is being sent right now — give it a moment, then refresh.' }, { status: 409 })
      return NextResponse.json({ error: 'This request was already decided or cancelled — refresh to see its current state.' }, { status: 409 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Approval cancel error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
