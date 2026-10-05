import { isUuidString } from '@/lib/utils/uuid'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { createServiceClient } from '@/lib/supabase/server'
import { lookupMissResponse } from '@/lib/documents/co-lookup'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { approvalSendInFlight, SEND_IN_FLIGHT_MESSAGE } from '@/lib/approvals/engine'
import { cancelCoApprovals } from '@/lib/documents/co-approval-cancel'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'
import { cleanTextField } from '@/lib/utils/sanitize'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'

// FIX (section-10 audit): this was documented and typed as a "shared
// handler for terminal non-accepted CO states: close, withdraw, decline"
// but nothing has ever called it with 'withdrawn' or 'declined' — the
// withdraw route (app/api/co/[id]/withdraw/route.ts) reimplements this
// logic independently, and there is no internal 'decline' action (only
// the client-facing portal route declines). The two implementations had
// already drifted: withdraw's TERMINAL_FROM allowed
// 'awaiting_countersignature' as a source status (added in migration 014
// doc-completeness fix) but this dead copy never got that update. Rather
// than leave an untested, silently-stale duplicate for a future dev to
// mistakenly wire up or "fix" in the wrong copy, narrowed this to what's
// actually used: 'closed' only. If withdraw/decline ever need to share
// logic with this again, extract a real shared helper both routes call,
// not a multi-status function only one status ever reaches.
async function handleTerminalCoState(
  id: string, newStatus: 'closed',
  session: any, service: any, body: any
) {
  // FIX (CO-logic fix round): expanded the select (client/workspace) so we
  // can notify the client below if this CO had already reached them —
  // same fields withdraw/route.ts already selects for the same reason.
  const { data: co, error: coLookupErr } = await (service as any)
    .from('change_orders')
    .select(`id,title,status,flag_id,token,project_id,
      projects(id,name,client_id,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
    .eq('id', id).eq('workspace_id', session.workspaceId).single()

  // The reason goes into the database, the audit trail and an email to the client: type-check it,
  // strip markup and cap it (it was stored verbatim at any length, and a non-string became jsonb junk).
  const cleanedReason = cleanTextField(body?.reason, 1000)
  if (cleanedReason === null)
    return NextResponse.json({ error: 'reason must be text' }, { status: 400 })
  const reason: string | null = cleanedReason || null

  if (!co) return lookupMissResponse(coLookupErr, 'CO not found')
  // FIX (audit round 3): see lib/utils/project-access.ts.
  if (!(await canReadProject(service, session, co.project_id)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // FIX (section-11 audit, pass 1 — B4): a final approval's auto-send is running right now — closing the CO
  // under it makes that send fail and leaves a false "Approved — not sent" behind. (cancelApprovalRequest
  // below deliberately skips a live send and used to say nothing about it.)
  if (await approvalSendInFlight(service, session.workspaceId, ['co', 'co_counter'], id))
    return NextResponse.json({ error: SEND_IN_FLIGHT_MESSAGE }, { status: 409 })

  const TERMINAL_FROM: Record<string, string[]> = {
    // FIX (doc-completeness audit, migration 014): 'awaiting_countersignature'
    // added alongside 'awaiting_response' for consistency — a CO stuck
    // waiting on either the client's initial response or their
    // countersignature should be closable the same way.
    // FIX (section-10 audit, feature gap — CO expiry): 'expired' added —
    // migration 044 + cron/co-expiry give a CO a genuine 'expired'
    // terminal state now; an agency that doesn't want to revise a dead
    // one should still be able to close it out like any other non-live
    // status, same as 'declined'/'withdrawn' already are.
    closed: ['draft','awaiting_response','declined','countered','stalled','awaiting_countersignature','expired'],
  }
  if (!TERMINAL_FROM[newStatus].includes(co.status))
    return NextResponse.json({ error: `Cannot ${newStatus} a CO with status ${co.status}` }, { status: 400 })

  // FIX (CO-logic fix round): a CO can be closed out of 'countered' —
  // the client made a counter-offer and is waiting on the agency's
  // response. Closing it here previously sent no notification at all,
  // unlike every other terminal transition in this lifecycle (withdraw
  // notifies the client; decline/accept are client-initiated). A client
  // who countered and then got silently closed out has no way to know
  // their offer was rejected rather than still pending. 'draft' never had
  // a client-facing state, so nothing to notify there.
  //
  // Deliberately NOT touching co.token/revoked_tokens the way withdraw
  // does: getCoByToken (api/portal/co/[token]/route.ts) already has a
  // dedicated, correctly-working 'closed' state for a client revisiting
  // their original link (see its own "BUG: 'closed', 'stalled', and
  // 'countered' were never included here" fix), which depends on the CO
  // still being resolvable by token so co.status can drive the response.
  // Nulling the token here would route that same revisit through the
  // revoked-token branch instead, which only special-cases 'withdrawn' and
  // would downgrade the client's page from the specific 'closed' state to
  // a generic 'revoked' one — trading a working, more informative path for
  // a token-hygiene win that isn't actually reachable by anyone else
  // (every mutating portal route already gates on co.status, same as the
  // SOW side's equivalent request-changes case).
  // Only a CO the client can still act on warrants a "closed" email. A declined or expired one is already dead
  // from their side (they declined it themselves / the link lapsed), so mailing them that it was "closed" is noise.
  const wasSentToClient = ['awaiting_response', 'stalled', 'countered', 'awaiting_countersignature'].includes(co.status)

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { status: newStatus, updated_at: now, close_reason: reason }

  // FIX (CO logic, independent pass 6): a 'draft' CO can have a pending 'co' approval request in flight (gated send)
  // and a 'countered' CO a pending 'co_counter' one (gated counter-acceptance) — closing the CO out from under either
  // one left it orphaned (pending forever, in the approver's queue, nagged by the stall cron). Both share this CO's id;
  // cancelling a kind with no pending row is a no-op. This now runs BEFORE the status write and its result is honoured:
  // the approvalSendInFlight check above reads the request earlier, so the last approver clearing the final step in
  // the gap stamped the send claim, cancelApprovalRequest refused (blockedBySend) and — running after the write and
  // ignoring that — this route closed the CO anyway. The auto-send then failed against a closed CO and left a false
  // "Approved — not sent" request that can never be retried. Refuse instead, like invoice DELETE does.
  const cancelled = await cancelCoApprovals(service, {
    workspaceId: session.workspaceId, coId: id,
    actorId: session.id, actorEmail: session.email, actorName: session.name,
    reason: 'CO closed',
  })
  if (cancelled.blockedBySend)
    return NextResponse.json({ error: SEND_IN_FLIGHT_MESSAGE }, { status: 409 })

  // FIX (section-10 audit, cross-cutting with withdraw): same missing CAS
  // — this wrote unconditionally on `.eq('id', id)` after only reading
  // co.status above (a read-then-write gap), while TERMINAL_FROM.closed
  // explicitly includes 'countered' — a live, open negotiation state. A
  // client submitting a counter-offer (CAS-protected: only succeeds while
  // status is still 'awaiting_response') at the same moment the agency
  // clicks Close (previously unprotected) could have their genuine
  // counter-offer silently overwritten back to 'closed' with no error to
  // either side — real negotiation data loss, not just a theoretical
  // race. Guard the write the same way every real signing-path transition
  // already does.
  const { data: closedCo } = await (service as any).from('change_orders')
    .update(updates)
    .eq('id', id)
    .eq('status', co.status)
    .select('id')

  if (!closedCo || closedCo.length === 0)
    return NextResponse.json({ error: 'This change order was already acted on by another action' }, { status: 409 })

  // BUG-048, spec §6.2: flag reversion fires on decline, close, AND withdraw
  // (decline/withdraw handle their own reversion independently — see
  // app/api/co/[id]/withdraw/route.ts and app/api/portal/co/[token]/_actions.ts)
  // Does NOT fire on stalled or countered (not terminal)
  if (co.flag_id) {
    const { data: flag } = await (service as any)
      .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()

    if (flag && flag.status === 'converted_to_co') {
      // FIX (deep audit, CO logic independent re-pass): the write itself now re-checks that
      // the flag is STILL converted_to_co AND still linked to THIS CO (or to nothing —
      // an orphaned link from a failed back-reference write). The read above is a
      // separate round trip, and status alone never proved which CO owns the flag.
      const { data: reverted } = await (service as any).from('guardian_flags').update({
        status:          'open',
        change_order_id: null,
        updated_at:      now,
      }).eq('id', co.flag_id).eq('status', 'converted_to_co')
        .or(`change_order_id.eq.${id},change_order_id.is.null`)
        .select('id')

      if (reverted && reverted.length > 0) await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'flag.reverted_to_open', entityType: 'guardian_flag',
        entityId: co.flag_id, entityName: co.projects?.name,
        metadata: { co_id: id, co_status: newStatus, reason: 'CO reached terminal non-accepted state' },
      })
    }
  }

  await logAudit(service, {
    workspaceId: session.workspaceId, actorId: session.id,
    actorEmail: session.email, actorName: session.name,
    eventType: `co.${newStatus}`, entityType: 'change_order',
    entityId: id, entityName: co.title,
    metadata: { ...(reason ? { reason } : {}), from_status: co.status },
  })

  const client = co.projects?.clients
  let clientNotified = true
  // An unverified member never triggers outbound client email (same rule as sending) — the action itself
  // still goes through, and the UI is told the client was not notified.
  if (wasSentToClient && client?.email && !session.emailVerifiedAt) clientNotified = false
  else if (wasSentToClient && client?.email) {
    const cc = await withPrimaryContactCc(service, co.projects?.client_id, client.email, client.cc_emails, 'co')
    const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
    const delivery = await checkedSend(() => sendDocumentCancelledEmail({
      replyTo,
      to: client.email, cc,
      clientName: client.name, agencyName: co.projects?.workspaces?.agency_name,
      projectName: co.projects?.name, documentLabel: 'Change Order',
      documentTitle: co.title, action: 'closed', reason,
      brandColour: co.projects?.workspaces?.brand_colour,
      log: { workspaceId: session.workspaceId, kind: 'co.close_notice', entityType: 'change_order', entityId: id, projectId: co.project_id, actorId: session.id },
    }), 'CO closed (client) email')
    clientNotified = delivery.ok
  }

  return NextResponse.json({ ok: true, clientNotified })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): this route had no permission check at all — every
    // other CO-mutating action (send, remind, escalate, accept-counter,
    // create, PATCH) requires SEND_CHANGE_ORDERS or CREATE_CHANGE_ORDERS, but
    // close() only checked that a session existed. Any authenticated
    // workspace member, regardless of role, could close any CO in the
    // workspace and trigger the linked flag-reversion side effect.
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })
    const body    = await request.json().catch(() => ({}))
    const service = createServiceClient()
    return handleTerminalCoState(id, 'closed', session, service, body)
  } catch (err) {
    console.error('CO close error:', err)
    return NextResponse.json({ error: 'Could not close this change order. Please try again.' }, { status: 500 })
  }
}
