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
import { cancelApprovalRequest } from '@/lib/approvals/engine'
import { sendCoExceptionGrantedEmail } from '@/lib/email/templates'
import { cleanTextField } from '@/lib/utils/sanitize'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'

const MAX_VALUE = 1e12

// Same source set close() allows into 'closed' from — anything that isn't already accepted (a signed,
// binding CO can't retroactively become free) or already a terminal exception/closed/withdrawn state.
const EXCEPTION_FROM = ['draft', 'awaiting_response', 'declined', 'countered', 'stalled', 'awaiting_countersignature', 'expired']

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
      .select(`id,title,status,flag_id,project_id,total,
        projects(id,name,client_id,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!EXCEPTION_FROM.includes(co.status))
      return NextResponse.json({ error: `Cannot grant an exception on a CO with status "${co.status}"` }, { status: 400 })

    // Estimated value: defaults to the CO's own total (the value actually being given away) but can be
    // overridden — e.g. only part of the CO's scope is being waived. Same validation as the flag-side
    // action: strict finite, non-negative, bounded (rejects "12abc"→12 coercion and Infinity/1e999).
    let estimatedValue: number
    const rawValue = body?.estimatedValue
    if (rawValue === undefined || rawValue === null || rawValue === '') estimatedValue = Number(co.total) || 0
    else if (typeof rawValue === 'number') estimatedValue = rawValue
    else if (typeof rawValue === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(rawValue)) estimatedValue = Number(rawValue)
    else estimatedValue = NaN
    if (!Number.isFinite(estimatedValue) || estimatedValue < 0 || estimatedValue > MAX_VALUE)
      return NextResponse.json({ error: 'Estimated value must be a non-negative number' }, { status: 400 })
    estimatedValue = Math.round(estimatedValue * 100) / 100

    const now = new Date().toISOString()
    // CAS, same shape as close()'s: only the request that actually observes and flips this exact status
    // proceeds — a concurrent close/withdraw/client-response can't be silently overwritten.
    // Token deliberately left alone (matching close()'s own reasoning, see that file): the portal's
    // dedicated terminal-state branch for 'exception_granted' resolves the CO directly by its still-live
    // token, exactly like 'closed' already does, rather than through the revoked-token path.
    const { data: grantedCo, error: grantErr } = await (service as any).from('change_orders')
      .update({ status: 'exception_granted', updated_at: now })
      .eq('id', id).eq('status', co.status)
      .select('id')
    if (grantErr) throw new Error(grantErr.message)
    if (!grantedCo || grantedCo.length === 0)
      return NextResponse.json({ error: 'This change order was already acted on by another action' }, { status: 409 })

    // Same orphaned-approval-request cleanup close() does: a 'draft' CO can have a pending 'co' approval
    // in flight, a 'countered' one a pending 'co_counter' — both would otherwise sit in the approver's
    // queue forever, still nagged about by approval-stall, referencing a CO no longer in any open state.
    await cancelApprovalRequest(service, {
      documentType: 'co', documentId: id, workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'CO granted as an exception',
    })
    await cancelApprovalRequest(service, {
      documentType: 'co_counter', documentId: id, workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'CO granted as an exception',
    })

    const grantedWhat = grantedWhatInput || co.title

    const { error: excErr } = await (service as any).from('exceptions_log').insert({
      project_id:      co.project_id,
      workspace_id:    session.workspaceId,
      flag_id:         co.flag_id || null,
      deliverable:     co.title,
      granted_what:    grantedWhat,
      granted_by:      session.id,
      estimated_value: estimatedValue,
      reason:          reasonText,
    })
    // Not fatal to the grant itself (the CO's own status change and audit row are the source of truth
    // for "this happened"), but must never be silent — an exception without its Reports/at-risk-value
    // entry is exactly the kind of gap this pass exists to close.
    if (excErr) console.error('CO exception grant: exceptions_log insert failed (non-fatal):', excErr.message)

    // Resolve the linked flag as an EXCEPTION — not the 'open'/change_order_id:null reversion close()
    // and withdraw() do. Those represent "this CO went away, the underlying request is unresolved
    // again"; here the request was granted, so the flag's own history should say so, exactly the way
    // the flag-side 'exception' action already records it for a flag that was never converted to a CO.
    if (co.flag_id) {
      const { data: flag } = await (service as any)
        .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()
      if (flag?.status === 'converted_to_co') {
        const { error: flagErr } = await (service as any).from('guardian_flags').update({
          status: 'resolved', resolution: 'exception',
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', co.flag_id).eq('status', 'converted_to_co')
        if (flagErr) console.error('CO exception grant: linked flag resolution failed (non-fatal):', flagErr.message)
        else {
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
    const wasSentToClient = co.status !== 'draft'
    let clientNotified = true
    if (wasSentToClient && client?.email) {
      const cc = await withPrimaryContactCc(service, co.projects?.client_id, client.email, client.cc_emails, 'co')
      const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
      const delivery = await checkedSend(() => sendCoExceptionGrantedEmail({
        replyTo, to: client.email, cc,
        clientName: client.name, agencyName: co.projects?.workspaces?.agency_name,
        projectName: co.projects?.name, coTitle: co.title, note: reasonText,
        brandColour: co.projects?.workspaces?.brand_colour,
      }), 'CO exception granted (client) email')
      clientNotified = delivery.ok
    }

    return NextResponse.json({ ok: true, clientNotified })
  } catch (err) {
    console.error('CO exception grant error:', err)
    return NextResponse.json({ error: 'Could not grant this exception. Please try again.' }, { status: 500 })
  }
}
