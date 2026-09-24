export const runtime = 'nodejs'

import { resolveReplyTo } from '@/lib/email/reply-to'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'
import { cancelApprovalRequest } from '@/lib/approvals/engine'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    // FIX (section-12 audit, pass 2): `body.reason.trim()` threw on a non-string
    // (opaque 500) and the reason was unbounded — it goes into the audit row and
    // the email the client receives.
    if (body?.reason != null && typeof body.reason !== 'string')
      return NextResponse.json({ error: 'Reason must be text' }, { status: 400 })
    const reason: string | undefined = body?.reason?.trim() || undefined
    if (reason && reason.length > 500)
      return NextResponse.json({ error: 'Please keep the reason under 500 characters' }, { status: 400 })
    const acknowledgePayments = body?.acknowledgePayments === true

    const service = createServiceClient()
    // FIX (doc-completeness audit): only select() addition is
    // sent_at/clients/workspaces — needed so the client can be notified
    // that this invoice (which they may already have in their inbox) is
    // no longer valid. Everything else in this route is unchanged.
    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`id, title, status, amount, amount_paid, currency, token, milestone_id, project_id, sent_at,
        projects(name, client_id, clients(name, email, cc_emails), workspaces(agency_name, brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status === 'void')
      return NextResponse.json({ error: 'Invoice is already void' }, { status: 400 })
    // FIX (section-12 audit, pass 2): a DRAFT could be voided (the UI never offers
    // it, but the API allowed it) — leaving a numberless 'void' row instead of a
    // clean delete, and an approval-gated draft's request cancelled as a side effect.
    if (invoice.status === 'draft')
      return NextResponse.json({ error: 'A draft invoice was never sent — delete it instead of voiding it' }, { status: 400 })
    if (invoice.status === 'paid')
      return NextResponse.json({ error: 'A fully paid invoice cannot be voided — record a refund or credit note outside ScopeGov and keep the invoice as the record of the sale' }, { status: 400 })

    // FIX (section-12 audit, pass 2 — feature gap): voiding a part-paid invoice used
    // to require DELETING the recorded payments first — destroying the very ledger
    // that shows money was received (only an audit row kept the amounts). The
    // payments now stay on file: the caller must acknowledge that money was already
    // received and give a reason, and the amount is recorded in the audit trail.
    const paidSoFar = Number(invoice.amount_paid) || 0
    if (paidSoFar > 0 && !(acknowledgePayments && reason)) {
      return NextResponse.json({
        error: `${paidSoFar.toFixed(2)} ${invoice.currency || ''} has already been received on this invoice. Voiding keeps the payment records on file — you'll need to refund or credit that money to the client separately. Give a reason and confirm to continue.`.replace('  ', ' '),
        code: 'has_payments', amountPaid: paidSoFar,
      }, { status: 409 })
    }

    const now = new Date().toISOString()
    // FIX (section-12 audit, TOCTOU race): the read above blocks voiding
    // if amount_paid > 0, but the write here had no compare-and-swap
    // condition — it fired unconditionally on `id`. If a payment landed
    // via the separate POST /api/invoices/[id]/payments route in the gap
    // between that read and this write, this update still overwrote the
    // trigger's correct 'partially_paid'/'paid' status back to 'void',
    // leaving a "voided" invoice with a real, committed payment still on
    // file — exactly the state this route's own guard exists to prevent.
    // CAS on amount_paid = 0 (guaranteed by the check above at read time)
    // closes the window the same way every other money-mutating route in
    // this app already guards its writes.
    const { data: voided, error } = await (service as any).from('invoices').update({
      status:      'void',
      voided_at:   now,
      void_reason: reason || null,
      updated_at:  now,
    }).eq('id', id).eq('amount_paid', paidSoFar).in('status', ['sent', 'partially_paid', 'overdue']).select('id').maybeSingle()

    if (error) return NextResponse.json({ error: 'Failed to void invoice' }, { status: 500 })
    // The write above is guarded on BOTH the payment total the caller confirmed and a
    // still-voidable status: a payment landing in the gap, a paid-off invoice, or —
    // FIX (section-12 audit, pass 2) — a second concurrent void (a double-click),
    // which used to pass the same guards, void the invoice twice and email the client
    // "voided" twice.
    if (!voided)
      return NextResponse.json({
        error: 'This invoice just changed (a payment was recorded, or it was already voided) — refresh and try again',
      }, { status: 409 })

    // FIX (section-12 fix round): void had no status check excluding a
    // still-'draft', approval-gated invoice (one under review stays
    // 'draft' the whole time — see the send route), and never called
    // cancelApprovalRequest the way DELETE does for the same case. Voiding
    // one directly (bypassing the UI, which never offers Void for a draft)
    // would leave a 'pending' approval_requests row forever notifying an
    // approver about an invoice that's now void. Safe to call
    // unconditionally — it's a no-op when there's nothing pending.
    await cancelApprovalRequest(service, {
      documentType: 'invoice', documentId: id, workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: reason || 'Invoice voided',
    })

    // Revoke the portal token, same pattern as SOW/CO withdraw — the client
    // link should stop resolving once an invoice is voided.
    if (invoice.token) {
      // FIX (cron/portal audit round 2): this used `reason: reason || 'voided'` — the agency's FREE TEXT (or
      // 'voided'), which the table's CHECK constraint (withdrawn/declined/superseded/manual/expired) rejects,
      // and token_type 'invoice' was rejected too (migration 063 allows it). The insert failed on every void
      // and the error was never read. 'manual' is the correct revocation reason; the agency's own reason is
      // already in the invoice/audit record.
      const { error: revokeErr } = await (service as any).from('revoked_tokens').insert({
        token: invoice.token, token_type: 'invoice', revoked_by: session.id, reason: 'manual', document_id: invoice.id,
      })
      if (revokeErr && (revokeErr as any).code !== '23505')
        console.error('Invoice void: could not revoke the portal token (status check still blocks the link):', revokeErr.message)
    }

    // If this invoice had put the milestone in 'invoiced', revert it to
    // 'pending' so it doesn't silently look billed when it no longer is.
    if (invoice.milestone_id) {
      // Only if no OTHER live invoice still bills this milestone (legacy duplicates).
      const { data: stillBilled } = await (service as any)
        .from('invoices').select('id').eq('milestone_id', invoice.milestone_id).neq('id', id).neq('status', 'void').limit(1)
      if (!stillBilled || stillBilled.length === 0) {
        await (service as any).from('payment_milestones')
          .update({ status: 'pending', invoiced_at: null })
          .eq('id', invoice.milestone_id).eq('status', 'invoiced')
      }
    }

    // FIX (doc-completeness audit): notify the client — only relevant if
    // it had actually been sent to them (draft invoices never reached
    // them, so there's nothing to warn them about).
    // FIX (section-11/12 fix round): this was the one caller of
    // sendDocumentCancelledEmail left on a bare try/catch instead of
    // checkedSend — sow/[id]/withdraw, co/[id]/close, and co/[id]/withdraw
    // all send this same "document cancelled" email through checkedSend and
    // return clientNotified so the UI can warn on a rejected delivery (the
    // Resend SDK resolves `{ error }` instead of throwing, so a plain
    // try/catch can never see that failure). This route was reporting a
    // silent success — the invoice was voided, but if the client's email
    // was rejected, nobody was told the client never actually heard about it.
    const client = invoice.projects?.clients
    let clientNotified = true
    if (invoice.sent_at && client?.email) {
      // FIX (deep audit, section 14 — traced bug): same missing
      // withPrimaryContactCc call as invoices/[id]/remind — see that
      // route's comment.
      const cc = await withPrimaryContactCc(service, invoice.projects?.client_id, client.email, client.cc_emails)
      const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
      const delivery = await checkedSend(() => sendDocumentCancelledEmail({
        replyTo,
        to: client.email, cc,
        clientName: client.name, agencyName: invoice.projects?.workspaces?.agency_name,
        projectName: invoice.projects?.name, documentLabel: 'Invoice',
        documentTitle: invoice.title, action: 'voided', reason: reason || null,
        brandColour: invoice.projects?.workspaces?.brand_colour,
      }), 'Invoice voided (client) email')
      clientNotified = delivery.ok
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.voided', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
      metadata: { reason: reason || null, ...(paidSoFar > 0 ? { amount_paid_at_void: paidSoFar, payments_kept: true } : {}) },
    })

    return NextResponse.json({ ok: true, clientNotified })
  } catch (err) {
    console.error('Invoice void error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
