import { resolveReplyTo } from '@/lib/email/reply-to'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { cancelApprovalRequest } from '@/lib/approvals/engine'
import { canReadProject } from '@/lib/utils/project-access'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'
import { cleanTextField } from '@/lib/utils/sanitize'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id,title,status,flag_id,token,project_id,
        projects(name,client_id,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
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

    const wasSentToClient = co.status !== 'draft'

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
    const { data: withdrawnCo } = await (service as any).from('change_orders')
      .update({ status: 'withdrawn', token: null, updated_at: now })
      .eq('id', id)
      .in('status', WITHDRAWABLE_FROM)
      .select('id')

    if (!withdrawnCo || withdrawnCo.length === 0)
      return NextResponse.json({ error: 'This change order was already acted on by another action' }, { status: 409 })

    // Phase 3: a draft CO can have an approval chain in flight (that's the
    // whole point of gating send, not create) — don't leave it dangling
    // for an approver once the CO itself is withdrawn.
    await cancelApprovalRequest(service, {
      documentType: 'co', documentId: id, workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'CO withdrawn',
    })

    // Revoke token
    if (co.token) {
      const { error: revokeErr } = await (service as any).from('revoked_tokens').insert({
        token: co.token, token_type: 'co', reason: 'withdrawn', revoked_by: session.id, document_id: id,
      })
      if (revokeErr) console.error('CO withdraw: token revoke insert failed (non-fatal):', revokeErr.message)
    }

    // BUG-048: revert linked flag on withdraw
    if (co.flag_id) {
      const { data: flag } = await (service as any)
        .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()
      if (flag?.status === 'converted_to_co') {
        await (service as any).from('guardian_flags').update({
          status: 'open', change_order_id: null, updated_at: now,
        }).eq('id', co.flag_id)
        await logAudit(service, {
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
    if (wasSentToClient && client?.email) {
      const cc = await withPrimaryContactCc(service, co.projects?.client_id, client.email, client.cc_emails)
      const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
      const delivery = await checkedSend(() => sendDocumentCancelledEmail({
        replyTo,
        to: client.email, cc,
        clientName: client.name, agencyName: co.projects?.workspaces?.agency_name,
        projectName: co.projects?.name, documentLabel: 'Change Order',
        documentTitle: co.title, action: 'withdrawn', reason: reason || null,
        brandColour: co.projects?.workspaces?.brand_colour,
      }), 'CO withdrawn (client) email')
      clientNotified = delivery.ok
    }

    return NextResponse.json({ ok: true, clientNotified })
  } catch (err) {
    console.error('CO withdraw error:', err)
    return NextResponse.json({ error: 'Could not withdraw this change order. Please try again.' }, { status: 500 })
  }
}
