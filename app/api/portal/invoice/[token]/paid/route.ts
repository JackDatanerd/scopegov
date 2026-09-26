export const runtime = 'nodejs'

// FEATURE (cron/portal audit round 3): "I've paid this" from the invoice portal.
//
// The portal only let a client dispute an invoice. The far more common message is "I've already paid" — sent
// days before the agency's bank shows it — and until now the client's only options were to email the agency
// out of band or to keep receiving overdue reminders for money already sent. This records the claim, tells the
// agency's finance people, and pauses the automatic client reminders (cron/client-reminders) for that invoice.
//
// Deliberately NOT a payment: a client-asserted "paid" must never change invoices.status / amount_paid (that is
// the agency's ledger, recorded through /api/invoices/[id]/payments, which also clears the claim). It is an
// informational stamp exactly like disputed_at — the same "make the silence visible" job every other portal
// action does.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { cleanTextField } from '@/lib/utils/sanitize'
import { resolveInvoiceToken } from '@/lib/documents/invoice-token'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendInvoicePaymentClaimedEmail, sendClientResponseReceivedEmail } from '@/lib/email/templates'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'
import { checkedSend } from '@/lib/email/delivery'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'

const OPEN_STATUSES = ['sent', 'partially_paid', 'overdue']

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()

    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'invoice.paid')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'invoice.paid')

    const body = await request.json().catch(() => ({} as any))
    // Both fields are optional free text from an unauthenticated link holder: type-checked, markup-stripped, capped.
    const reference = cleanTextField(body?.reference ?? '', 200)
    const note      = cleanTextField(body?.note ?? '', 1000)
    if (reference === null || note === null)
      return NextResponse.json({ error: 'reference and note must be text' }, { status: 400 })

    // FIX (re-audit, section 18): widened to include client_id, cc_emails and workspaces(agency_name,
    // brand_colour) — needed for the new client receipt email below (withPrimaryContactCc +
    // sendClientResponseReceivedEmail), the same fields the sibling dispute route already selects.
    const resolved = await resolveInvoiceToken(service, token, `id, title, invoice_number, status, amount, amount_paid, currency, workspace_id, project_id,
      payment_claimed_at, payment_claim_cleared_at,
      projects(id, name, client_id, clients(name, email, cc_emails), workspaces(agency_name, brand_colour))`)
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    const invoice = resolved.invoice

    if (invoice.status === 'paid')
      return NextResponse.json({ error: 'This invoice is already marked as paid — thank you.' }, { status: 409 })
    if (!OPEN_STATUSES.includes(invoice.status))
      return NextResponse.json({ error: 'This invoice can no longer be updated.' }, { status: 409 })

    // A claim that is still open (never cleared by a recorded payment) is acknowledged, not re-announced: a
    // double-click, a retry after a timeout or a replayed POST must not notify finance twice.
    const open = invoice.payment_claimed_at && (!invoice.payment_claim_cleared_at
      || new Date(invoice.payment_claim_cleared_at) < new Date(invoice.payment_claimed_at))
    if (open) return NextResponse.json({ ok: true, duplicate: true, claimedAt: invoice.payment_claimed_at })

    const now = new Date().toISOString()
    const project = invoice.projects
    const client  = project?.clients

    const { error: claimErr } = await (service as any).from('invoices')
      .update({
        payment_claimed_at: now, payment_claim_reference: reference.trim() || null,
        payment_claim_note: note.trim() || null, payment_claim_cleared_at: null,
      })
      .eq('id', invoice.id).in('status', OPEN_STATUSES)
    if (claimErr) {
      console.error('Invoice payment claim: update failed:', claimErr)
      return NextResponse.json({ error: 'Could not record your message — please try again.' }, { status: 500 })
    }

    const balanceDue = Math.max(0, Number(invoice.amount) - Number(invoice.amount_paid))

    await logAudit(service, {
      workspaceId: invoice.workspace_id, actorId: null,
      actorEmail: client?.email || 'portal@client', actorName: client?.name || 'Client',
      eventType: 'invoice.payment_claimed', entityType: 'invoice',
      entityId: invoice.id, entityName: invoice.title,
      metadata: { reference: reference.trim() || null, note: note.trim() || null, balance_due: balanceDue },
    })

    await notifyMembersWithPermission(service, {
      workspaceId: invoice.workspace_id, permission: 'VIEW_FINANCIALS', eventType: 'invoice_payment_claimed',
      type: 'invoice_payment_claimed', title: `Client says they've paid — ${project?.name || invoice.title}`,
      body: `${client?.name || 'The client'} says invoice ${invoice.invoice_number || invoice.title} has been paid${reference.trim() ? ` (ref: ${reference.trim()})` : ''}. Check your account and record the payment.`.slice(0, 200),
      entityType: 'project', entityId: project?.id, projectId: project?.id,
    })

    try {
      const emails = await getMemberEmailsWithPermission(service, invoice.workspace_id, 'VIEW_FINANCIALS', 25, 'invoice_payment_claimed', project?.id)
      if (emails.length) {
        // FIX (re-audit, section 18): raw try/catch, not checkedSend — a Resend-level rejection
        // resolved normally instead of throwing, so this silently "succeeded" while finance never
        // actually heard the client said they'd paid. Same fix as the dispute route.
        await checkedSend(() => sendInvoicePaymentClaimedEmail({
          to: emails, clientName: client?.name || 'Client', projectName: project?.name || invoice.title,
          invoiceNumber: invoice.invoice_number, balanceDue, currency: invoice.currency || 'USD',
          reference: reference.trim() || null, note: note.trim() || null,
          projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project?.id}?tab=billing`,
        }), 'Invoice payment claimed (agency) email')
      }
    } catch (e) { console.error('Invoice payment-claimed email failed:', e) }

    // FIX (re-audit, section 18 — feature gap): every other client-initiated portal response (SOW
    // decline/request-changes, CO decline/counter, invoice dispute) sends the client a "we received
    // your response" receipt — this was the one exception. The client had only the in-page UI
    // confirmation, which is gone the moment they close the tab.
    if (client?.email) {
      const cc = await withPrimaryContactCc(service, project?.client_id, client.email, client.cc_emails, 'invoice')
      const replyTo = await resolveReplyTo(service, invoice.workspace_id, null)
      await checkedSend(() => sendClientResponseReceivedEmail({
        replyTo,
        to: client.email, cc, clientName: client.name, agencyName: project?.workspaces?.agency_name || '',
        projectName: project?.name || invoice.title, documentLabel: 'Invoice', response: "told us you've paid",
        note: note.trim() ? note.trim().slice(0, 500) : (reference.trim() ? `Reference: ${reference.trim()}` : null),
        brandColour: project?.workspaces?.brand_colour,
      }), 'Invoice payment claimed (client receipt)')
    }

    return NextResponse.json({ ok: true, claimedAt: now })
  } catch (err) {
    console.error('Invoice payment claim error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
