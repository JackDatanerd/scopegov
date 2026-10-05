import { isUuidString } from '@/lib/utils/uuid'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { createServiceClient } from '@/lib/supabase/server'
import { lookupMissResponse } from '@/lib/documents/co-lookup'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { approvalSendInFlight, SEND_IN_FLIGHT_MESSAGE } from '@/lib/approvals/engine'
import { cancelCoApprovals } from '@/lib/documents/co-approval-cancel'
import { canReadProject } from '@/lib/utils/project-access'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'
import { cleanTextField } from '@/lib/utils/sanitize'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'
import { releaseFlagFromCo } from '@/lib/documents/co-flag'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): same gap as close/route.ts — no permission check
    // at all. Any authenticated workspace member could withdraw any CO
    // (killing the client's portal link and cancelling an in-flight
    // approval chain) with none of the permissions every sibling action
    // requires.
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const cleanedReason = cleanTextField(body?.reason, 1000)
    if (cleanedReason === null)
      return NextResponse.json({ error: 'reason must be text' }, { status: 400 })
    const reason: string | undefined = cleanedReason || undefined

    const service = createServiceClient()
    // FIX (doc-completeness audit): added client/workspace so we can
    // notify the client if this CO had already reached them.
    const { data: co, error: coLookupErr } = await (service as any)
      .from('change_orders')
      .select(`id,title,status,flag_id,token,project_id,
        projects(name,client_id,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return lookupMissResponse(coLookupErr, 'Not found')
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    // FIX (doc-completeness audit, migration 014): the agency should be
    // able to cancel a CO that's waiting on the client to countersign the
    // negotiated amount, same as any other open state.
    // 'stalled' is a live, sent CO (awaiting_response that the agency has not heard back on) — it had
    // no way out except Close.
    const WITHDRAWABLE_FROM = ['awaiting_response', 'stalled', 'draft', 'awaiting_countersignature']
    if (!WITHDRAWABLE_FROM.includes(co.status))
      return NextResponse.json({ error: 'Cannot withdraw CO in current status' }, { status: 400 })

    // FIX (section-11 audit, pass 1 — B4): see close/route.ts — don't pull the CO out from under a final approval's
    // auto-send that is running right now.
    if (co.status === 'draft' && await approvalSendInFlight(service, session.workspaceId, ['co'], id))
      return NextResponse.json({ error: SEND_IN_FLIGHT_MESSAGE }, { status: 409 })

    const wasSentToClient = co.status !== 'draft'

    // FIX (CO logic, independent pass 6): a draft CO can have an approval chain in flight (that's the whole point of
    // gating send, not create) — it must not be left dangling for an approver once the CO is withdrawn. This ran AFTER
    // the status write and ignored cancelApprovalRequest's `blockedBySend`: the last approver clearing the final step
    // between the approvalSendInFlight check above and the write stamped the send claim, the cancel was refused, and
    // the CO was withdrawn anyway — the auto-send then failed against a withdrawn CO and left an unretryable
    // "Approved — not sent" request. Cancel FIRST and refuse when a send is live (same as invoice DELETE). Only a
    // draft can hold a 'co' request, so only that kind is looked up.
    const cancelled = await cancelCoApprovals(service, {
      workspaceId: session.workspaceId, coId: id,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'CO withdrawn', types: ['co'],
    })
    if (cancelled.blockedBySend)
      return NextResponse.json({ error: SEND_IN_FLIGHT_MESSAGE }, { status: 409 })

    const now = new Date().toISOString()
    // FIX (section-10 audit, cross-cutting with app/api/sow/[id]/withdraw
    // — same missing CAS, same fix): this wrote unconditionally on
    // `.eq('id', id)` alone, unlike every real signing-path transition in
    // this lifecycle (accept/decline/counter/countersign/accept-counter
    // all CAS on the status they read). A withdraw racing a client's
    // simultaneous Accept/Counter/Countersign could stomp an
    // already-finalized CO back to 'withdrawn' with the token nulled, and
    // even a plain double-click of Withdraw itself duplicated the
    // client-facing cancellation email and audit-log entry below.
    const { data: withdrawnCo, error: withdrawErr } = await (service as any).from('change_orders')
      .update({ status: 'withdrawn', token: null, updated_at: now })
      .eq('id', id)
      // CO-3: guard on the exact status that was READ, not on "any withdrawable status". The rest of this handler
      // (wasSentToClient, the token to revoke, the client email) is derived from that read: a draft that a
      // concurrent send moved to awaiting_response still matched the wider list, so it was withdrawn with the
      // freshly-issued token never revoked and the client never told - their link just died silently.
      .eq('status', co.status)
      .select('id')

    // A failed write is not a lost race (it used to answer "already acted on by another action").
    if (withdrawErr) throw new Error(`could not withdraw the change order: ${withdrawErr.message}`)
    if (!withdrawnCo || withdrawnCo.length === 0)
      return NextResponse.json({ error: 'This change order was already acted on by another action' }, { status: 409 })

    // Revoke token
    if (co.token) {
      const { error: revokeErr } = await (service as any).from('revoked_tokens').insert({
        token: co.token, token_type: 'co', reason: 'withdrawn', revoked_by: session.id, document_id: id,
      })
      if (revokeErr) console.error('CO withdraw: token revoke insert failed (non-fatal):', revokeErr.message)
    }

    // BUG-048: revert linked flag on withdraw
    if (co.flag_id) {
      {
        // One guarded conditional update, retried and logged on failure - see lib/documents/co-flag.ts.
        const { released } = await releaseFlagFromCo(service, { flagId: co.flag_id, coId: id, now })
        if (released) await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name,
          eventType: 'flag.reverted_to_open', entityType: 'guardian_flag',
          entityId: co.flag_id, entityName: co.projects?.name,
          metadata: { co_id: id, reason: 'CO withdrawn' },
        })
      }
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.withdrawn', entityType: 'change_order',
      entityId: id, entityName: co.title, metadata: reason ? { reason } : {},
    })

    // FIX (doc-completeness audit): notify the client if this CO had ever
    // actually reached them — a draft never had a token sent, so nothing
    // to warn them about in that case.
    const client = co.projects?.clients
    let clientNotified = true
    if (wasSentToClient && client?.email && !session.emailVerifiedAt) clientNotified = false
    else if (wasSentToClient && client?.email) {
      const cc = await withPrimaryContactCc(service, co.projects?.client_id, client.email, client.cc_emails, 'co')
      const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
      const delivery = await checkedSend(() => sendDocumentCancelledEmail({
        replyTo,
        to: client.email, cc,
        clientName: client.name, agencyName: co.projects?.workspaces?.agency_name,
        projectName: co.projects?.name, documentLabel: 'Change Order',
        documentTitle: co.title, action: 'withdrawn', reason: reason || null,
        brandColour: co.projects?.workspaces?.brand_colour,
        log: { workspaceId: session.workspaceId, kind: 'co.withdraw_notice', entityType: 'change_order', entityId: id, projectId: co.project_id, actorId: session.id },
      }), 'CO withdrawn (client) email')
      clientNotified = delivery.ok
    }

    return NextResponse.json({ ok: true, clientNotified })
  } catch (err) {
    console.error('CO withdraw error:', err)
    return NextResponse.json({ error: 'Could not withdraw this change order. Please try again.' }, { status: 500 })
  }
}
