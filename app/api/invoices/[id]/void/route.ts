export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'
import { cancelApprovalRequest } from '@/lib/approvals/engine'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const reason: string | undefined = body?.reason?.trim()

    const service = createServiceClient()
    // FIX (doc-completeness audit): only select() addition is
    // sent_at/clients/workspaces — needed so the client can be notified
    // that this invoice (which they may already have in their inbox) is
    // no longer valid. Everything else in this route is unchanged.
    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`id, title, status, amount_paid, token, milestone_id, project_id, sent_at,
        projects(name, client_id, clients(name, email, cc_emails), workspaces(agency_name, brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status === 'void')
      return NextResponse.json({ error: 'Invoice is already void' }, { status: 400 })
    if (invoice.status === 'paid')
      return NextResponse.json({ error: 'A fully paid invoice cannot be voided' }, { status: 400 })
    if (Number(invoice.amount_paid) > 0)
      return NextResponse.json({ error: 'Remove or correct recorded payments before voiding this invoice' }, { status: 400 })

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
    }).eq('id', id).eq('amount_paid', 0).select('id').maybeSingle()

    if (error) return NextResponse.json({ error: 'Failed to void invoice' }, { status: 500 })
    if (!voided)
      return NextResponse.json({
        error: 'A payment was just recorded on this invoice — refresh and remove or correct it before voiding',
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
      await (service as any).from('revoked_tokens').insert({
        token: invoice.token, token_type: 'invoice', revoked_by: session.id, reason: reason || 'voided',
      })
    }

    // If this invoice had put the milestone in 'invoiced', revert it to
    // 'pending' so it doesn't silently look billed when it no longer is.
    if (invoice.milestone_id) {
      await (service as any).from('payment_milestones')
        .update({ status: 'pending', invoiced_at: null })
        .eq('id', invoice.milestone_id).eq('status', 'invoiced')
    }

    // FIX (doc-completeness audit): notify the client — only relevant if
    // it had actually been sent to them (draft invoices never reached
    // them, so there's nothing to warn them about).
    const client = invoice.projects?.clients
    if (invoice.sent_at && client?.email) {
      try {
        // FIX (deep audit, section 14 — traced bug): same missing
        // withPrimaryContactCc call as invoices/[id]/remind — see that
        // route's comment.
        const cc = await withPrimaryContactCc(service, invoice.projects?.client_id, client.email, client.cc_emails)
        await sendDocumentCancelledEmail({
          to: client.email, cc,
          clientName: client.name, agencyName: invoice.projects?.workspaces?.agency_name,
          projectName: invoice.projects?.name, documentLabel: 'Invoice',
          documentTitle: invoice.title, action: 'voided', reason: reason || null,
          brandColour: invoice.projects?.workspaces?.brand_colour,
        })
      } catch (e) { console.error('Invoice voided client email failed:', e) }
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.voided', entityType: 'invoice',
      entityId: id, entityName: invoice.title, metadata: { reason: reason || null },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice void error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
