export const runtime = 'nodejs'

// FEATURE (cron/portal audit, sections 17+18 — feature gap, closing pass): change_orders.status has
// carried an 'exception_granted' value since migration 044 — it's in the TypeScript status union, the
// badge label/colour map, the PDF renderer's status labels, scope-financial-data.ts's "closed"
// classification, and co/[id]/escalate's terminal-status guard — but nothing anywhere ever wrote it.
// The guardian_flags-side 'exception' action (app/api/guardian/flags/[id]/route.ts) grants an exception
// on a FLAG, and is gated on flag.status === 'open' — so it can never reach a flag that's already
// 'converted_to_co' (flag_id/change_order_id linked). There was no equivalent action for "this specific
// change order — already drafted, sent, countered, or stalled — is being given to the client for free
// instead of pursued to acceptance." This route is that action: mirrors close/route.ts's structure
// (same CO fetch, same CAS pattern, same approval-request cleanup) but resolves the linked flag as an
// EXCEPTION (mirrors the flag-side case exactly: exceptions_log row + guardian_flags 'resolved'/
// 'exception') rather than reverting it to 'open' the way close/withdraw do — the work described by the
// flag was in fact granted, not abandoned.
//
// Also closes the matching portal-side gap found in the same pass: app/api/portal/co/[token]/route.ts's
// getCoByToken() now recognises 'exception_granted' as a terminal, token-resolvable state (same pattern
// as its existing 'closed' handling), so a client revisiting the link sees the outcome instead of the
// live accept/decline/counter form.

import { resolveReplyTo } from '@/lib/email/reply-to'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { approvalSendInFlight, SEND_IN_FLIGHT_MESSAGE } from '@/lib/approvals/engine'
import { cancelCoApprovals } from '@/lib/documents/co-approval-cancel'
import { sendCoExceptionGrantedEmail } from '@/lib/email/templates'
import { cleanTextField } from '@/lib/utils/sanitize'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'

const MAX_VALUE = 1e12

// Same source set close() allows into 'closed' from — anything that isn't already accepted (a signed,
// binding CO can't retroactively become free) or already a terminal exception/closed/withdrawn state.
const EXCEPTION_FROM = ['draft', 'awaiting_response', 'declined', 'countered', 'stalled', 'awaiting_countersignature', 'expired']

// FIX (CO logic, independent pass 6): a newer version that was withdrawn or closed out is dead — it is not billable and
// it already released the flag, so it must not stop an exception being granted on the version before it. The guard
// below counted EVERY newer sibling, but a withdrawn/closed one is not in EXCEPTION_FROM, so the message told the user
// to "grant the exception on that one instead" when that version could not take one either: with v1 declined and v2
// withdrawn/closed, neither version could be given the exception (the only way out was revising v2 into a v3 draft just
// to waive it). Live, accepted and already-excepted newer versions still block, exactly as before.
const ABANDONED_STATUSES = ['withdrawn', 'closed']

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // Same permission the flag-side exception action requires — granting scope away for free is a
    // distinct authority from SEND_CHANGE_ORDERS (which close/withdraw/send use), not a lesser version
    // of it: a person who can send change orders isn't automatically someone who should be able to
    // give their value away.
    if (!hasPermission(session, 'GRANT_EXCEPTIONS'))
      return NextResponse.json({ error: 'Missing permission: GRANT_EXCEPTIONS' }, { status: 403 })

    const body = await request.json().catch(() => ({} as any))
    const reasonText = cleanTextField(body?.reason, 2000)
    if (!reasonText) return NextResponse.json({ error: 'A reason is required to grant an exception' }, { status: 400 })
    const grantedWhatInput = cleanTextField(body?.grantedWhat, 1000)
    if (grantedWhatInput === null) return NextResponse.json({ error: 'grantedWhat must be text' }, { status: 400 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id,title,status,flag_id,project_id,total,version,root_co_id,
        projects(id,name,client_id,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!EXCEPTION_FROM.includes(co.status))
      return NextResponse.json({ error: `Cannot grant an exception on a CO with status "${co.status}"` }, { status: 400 })

    // CO-B3: only the newest version of a lineage can be granted as an exception. Granting one on a superseded
    // version (declined/closed/expired v1 while v2 is out) wrote a ledger row saying the work was given away free while
    // v2 stayed billable, left the flag with the live version, and logged a flag resolution that never happened.
    {
      const rootId = (co as any).root_co_id || co.id
      const { data: siblings } = await (service as any)
        .from('change_orders').select('id, version, status')
        .or(`id.eq.${rootId},root_co_id.eq.${rootId}`).neq('id', co.id)
      // The NEWEST blocking version is the one to name: that is where the exception has to be granted.
      const newer = (siblings || [])
        .filter((o: any) => Number(o.version) > Number((co as any).version) && !ABANDONED_STATUSES.includes(o.status))
        .sort((a: any, b: any) => Number(b.version) - Number(a.version))[0]
      if (newer) {
        // Only point at that version when it can actually take the exception; an accepted or already-excepted newest
        // version is settled, so the honest answer is that this one can't be waived.
        const message = EXCEPTION_FROM.includes(newer.status)
          ? `A newer version (v${newer.version}) of this change order exists — grant the exception on that one instead.`
          : `A newer version (v${newer.version}) of this change order is ${String(newer.status).replace(/_/g, ' ')}, so an exception can't be granted on this one.`
        return NextResponse.json({ error: message }, { status: 409 })
      }
    }

    // FIX (section-11 audit, pass 1 — B4): a final approval's auto-send (or counter-acceptance) is running right
    // now — granting the exception first would make it fail and leave a false "Approved — not sent" behind.
    if (await approvalSendInFlight(service, session.workspaceId, ['co', 'co_counter'], id))
      return NextResponse.json({ error: SEND_IN_FLIGHT_MESSAGE }, { status: 409 })

    // Estimated value: defaults to the CO's own total (the value actually being given away) but can be
    // overridden — e.g. only part of the CO's scope is being waived. Same validation as the flag-side
    // action: strict finite, non-negative, bounded (rejects "12abc"→12 coercion and Infinity/1e999).
    let estimatedValue: number
    const rawValue = body?.estimatedValue
    if (rawValue === undefined || rawValue === null || rawValue === '') estimatedValue = Math.max(0, Number(co.total) || 0)  // a credit CO's total is negative — the value given away is then $0, not a validation error on a field the user never touched
    else if (typeof rawValue === 'number') estimatedValue = rawValue
    else if (typeof rawValue === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(rawValue)) estimatedValue = Number(rawValue)
    else estimatedValue = NaN
    if (!Number.isFinite(estimatedValue) || estimatedValue < 0 || estimatedValue > MAX_VALUE)
      return NextResponse.json({ error: 'Estimated value must be a non-negative number' }, { status: 400 })
    estimatedValue = Math.round(estimatedValue * 100) / 100

    const now = new Date().toISOString()
    const grantedWhat = grantedWhatInput || co.title

    // The exceptions_log row is the record Reports and the at-risk rollup read, so it is written FIRST. It used to
    // be written after the status flip and treated as non-fatal — a failed insert left a CO marked 'exception_granted'
    // with no ledger entry, and nothing could retry it (the CO was already terminal). Now a failed insert aborts
    // before any state changes; a lost race below removes the row again.
    // CO-D: exceptions_log allows ONE row per flag (migration 077, exceptions_log_one_per_flag). A flag that already
    // carries an exception row (granted on the flag side after an earlier version of this CO was declined and released
    // it) made this insert violate the index and the whole grant failed with a 500. The CO's own grant is still a real
    // ledger entry, so it is written without the flag link rather than refused.
    let ledgerFlagId: string | null = co.flag_id || null
    if (ledgerFlagId) {
      const { data: existingExc } = await (service as any).from('exceptions_log')
        .select('id').eq('flag_id', ledgerFlagId).limit(1)
      if (existingExc && existingExc.length > 0) ledgerFlagId = null
    }
    const { data: excRow, error: excErr } = await (service as any).from('exceptions_log').insert({
      project_id:      co.project_id,
      workspace_id:    session.workspaceId,
      flag_id:         ledgerFlagId,
      deliverable:     co.title,
      granted_what:    grantedWhat,
      granted_by:      session.id,
      estimated_value: estimatedValue,
      reason:          reasonText,
    }).select('id').single()
    if (excErr || !excRow) throw new Error(`exceptions_log insert failed: ${excErr?.message || 'no row'}`)

    // FIX (CO logic, independent pass 6): cancel the in-flight approval request(s) BEFORE the status flip and honour a
    // refused cancel. A 'draft' CO can have a pending 'co' request and a 'countered' one a pending 'co_counter' (both
    // would otherwise sit in the approver's queue forever). This used to run after the flip and ignore `blockedBySend`:
    // the last approver clearing the final step after the approvalSendInFlight check above stamped the send claim, the
    // cancel was refused, the exception was granted anyway, and the auto-send then failed against an
    // 'exception_granted' CO — a false "Approved — not sent". The ledger row written above is removed again, exactly as
    // for a lost status race below, because nothing was granted.
    const cancelled = await cancelCoApprovals(service, {
      workspaceId: session.workspaceId, coId: id,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'CO granted as an exception',
    })
    if (cancelled.blockedBySend) {
      await (service as any).from('exceptions_log').delete().eq('id', excRow.id)
      return NextResponse.json({ error: SEND_IN_FLIGHT_MESSAGE }, { status: 409 })
    }

    // CAS, same shape as close()'s: only the request that actually observes and flips this exact status
    // proceeds — a concurrent close/withdraw/client-response can't be silently overwritten.
    // Token deliberately left alone (matching close()'s own reasoning, see that file): the portal's
    // dedicated terminal-state branch for 'exception_granted' resolves the CO directly by its still-live
    // token, exactly like 'closed' already does, rather than through the revoked-token path.
    const { data: grantedCo, error: grantErr } = await (service as any).from('change_orders')
      .update({ status: 'exception_granted', updated_at: now })
      .eq('id', id).eq('status', co.status)
      .select('id')
    if (grantErr || !grantedCo || grantedCo.length === 0) {
      await (service as any).from('exceptions_log').delete().eq('id', excRow.id)
      if (grantErr) throw new Error(grantErr.message)
      return NextResponse.json({ error: 'This change order was already acted on by another action' }, { status: 409 })
    }

    // Resolve the linked flag as an EXCEPTION — not the 'open'/change_order_id:null reversion close()
    // and withdraw() do. Those represent "this CO went away, the underlying request is unresolved
    // again"; here the request was granted, so the flag's own history should say so, exactly the way
    // the flag-side 'exception' action already records it for a flag that was never converted to a CO.
    if (co.flag_id) {
      const { data: flag } = await (service as any)
        .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()
      // A CO that was declined (or expired) had its flag released back to 'open' by that path, so requiring
      // 'converted_to_co' here left the flag open after the work had been granted — Reports then counted the same
      // value twice (once as at-risk, once as an exception). 'open' is resolvable too; the change_order_id
      // filter below still refuses a flag a newer revision has re-claimed.
      if (flag && ['converted_to_co', 'open'].includes(flag.status)) {
        const { data: resolvedFlag, error: flagErr } = await (service as any).from('guardian_flags').update({
          status: 'resolved', resolution: 'exception',
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', co.flag_id).in('status', ['converted_to_co', 'open'])
          // Only resolve a flag still linked to THIS CO (or to nothing) — see app/api/co/route.ts.
          .or(`change_order_id.eq.${co.id},change_order_id.is.null`)
          .select('id')
        if (flagErr) console.error('CO exception grant: linked flag resolution failed (non-fatal):', flagErr.message)
        else if (resolvedFlag && resolvedFlag.length > 0) {
          await logAudit(service, {
            workspaceId: session.workspaceId, actorId: session.id,
            actorEmail: session.email, actorName: session.name,
            eventType: 'flag.exception_granted', entityType: 'guardian_flag',
            entityId: co.flag_id, entityName: co.projects?.name,
            metadata: { co_id: id, estimated_value: estimatedValue, via: 'co' },
          })
        }
      }
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.exception_granted', entityType: 'change_order',
      entityId: id, entityName: co.title,
      metadata: { reason: reasonText, granted_what: grantedWhat, estimated_value: estimatedValue, from_status: co.status },
    })

    const client = co.projects?.clients
    // Only a client who can still act on the CO needs to hear it was granted (see close/route.ts).
    const wasSentToClient = ['awaiting_response', 'stalled', 'countered', 'awaiting_countersignature'].includes(co.status)
    let clientNotified = true
    if (wasSentToClient && client?.email && !session.emailVerifiedAt) clientNotified = false
    else if (wasSentToClient && client?.email) {
      const cc = await withPrimaryContactCc(service, co.projects?.client_id, client.email, client.cc_emails, 'co')
      const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
      const delivery = await checkedSend(() => sendCoExceptionGrantedEmail({
        replyTo, to: client.email, cc,
        clientName: client.name, agencyName: co.projects?.workspaces?.agency_name,
        projectName: co.projects?.name, coTitle: co.title,
        // Deliberately NO note: `reason` is the agency's internal audit rationale (the modal describes it as the audit
        // trail, and its own example reads "one-time goodwill, not worth a CO for $200"). It used to be emailed to the
        // client verbatim as "Note from <agency>".
        brandColour: co.projects?.workspaces?.brand_colour,
        log: { workspaceId: session.workspaceId, kind: 'co.exception_notice', entityType: 'change_order', entityId: id, projectId: co.project_id, actorId: session.id },
      }), 'CO exception granted (client) email')
      clientNotified = delivery.ok
    }

    return NextResponse.json({ ok: true, clientNotified })
  } catch (err) {
    console.error('CO exception grant error:', err)
    return NextResponse.json({ error: 'Could not grant this exception. Please try again.' }, { status: 500 })
  }
}
