export const runtime = 'nodejs'

import { isUuidString } from '@/lib/utils/uuid'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInvoiceReminderEmail } from '@/lib/email/templates'
import { canReadProject } from '@/lib/utils/project-access'
import { checkReminderCooldown } from '@/lib/utils/reminder-cooldown'
import { renewInvoiceTokenIfExpired } from '@/lib/documents/renew-invoice-token'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { checkedSend } from '@/lib/email/delivery'
import { isPaymentClaimOpen } from '@/lib/utils/invoice-registry'
import { dateStringInZone, isValidTimeZone } from '@/lib/utils/timezone'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })
    // Same gate as send (and as the change-order reminder): an unverified member can't put mail in a client's inbox.
    if (!session.emailVerifiedAt)
      return NextResponse.json({ error: 'Please verify your email before sending reminders' }, { status: 403 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, amount_paid, currency, status, due_date, token, expires_at, invoice_number, project_id, payment_instructions,
        disputed_at, dispute_resolved_at, payment_claimed_at, payment_claim_cleared_at,
        projects(id, name, client_id, clients(name, email, cc_emails, payment_terms_note, timezone), workspaces(agency_name, brand_colour, timezone))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!['sent', 'partially_paid', 'overdue'].includes(invoice.status))
      return NextResponse.json({ error: 'Can only remind on unpaid, sent invoices' }, { status: 400 })
    if (!invoice.token)
      return NextResponse.json({ error: 'No portal link found — resend the invoice' }, { status: 400 })

    // FIX (build, cron/portal audit round): this used to resend the
    // reminder pointing at whatever token was already stored, with no
    // check that it still worked — invoice-expiry (the new daily cron)
    // renews a dead token once a day, but a click landing in the gap
    // between the old token dying and that cron's next run would still
    // resend a broken link. Renewing defensively here closes that window
    // immediately rather than waiting on the cron — see
    // renew-invoice-token.ts for why renewal (not expiry) is the right
    // behaviour for an invoice's link.
    // FIX (section-12 audit, pass 2): the automatic reminders already skip an invoice
    // the client has an open dispute on ("answering it is the agency's move, not a
    // nag"), but the manual Remind button didn't — one click could chase a client
    // who had just questioned the invoice. Ask first; the caller can confirm.
    const underDispute = !!invoice.disputed_at && !invoice.dispute_resolved_at
    const body = await request.json().catch(() => ({}))
    if (underDispute && body?.force !== true)
      return NextResponse.json({
        error: 'The client has an open dispute on this invoice. Answer or resolve it before chasing payment — or confirm to send the reminder anyway.',
        code: 'disputed',
      }, { status: 409 })

    // FIX (section-12 re-audit — bug): the automatic reminders already skip an invoice
    // with an open "I've paid this" claim (cron/client-reminders' own hasOpenPaymentClaim)
    // on the same reasoning as the dispute check above — chasing payment on money the
    // client just said they sent is the wrong move — but this manual button had no
    // equivalent check, so one click could still nag a client who'd just told the agency
    // they'd paid. Same ask-first shape as the dispute check; `force` covers both.
    if (isPaymentClaimOpen(invoice) && body?.force !== true)
      return NextResponse.json({
        error: 'The client has already told you they paid this invoice. Check for the payment before chasing them again — or confirm to send the reminder anyway.',
        code: 'payment_claimed',
      }, { status: 409 })

    // FIX (re-audit): no cooldown existed at all — an agency user could
    // spam this button and spam the client's inbox with no rate limit.
    const cooldown = await checkReminderCooldown(service, 'invoice', id)
    if (!cooldown.allowed) return NextResponse.json({ error: cooldown.message }, { status: 429 })

    // FIX (section-12 audit, pass 2): the portal token was renewed BEFORE the cooldown
    // and client-email checks, so a reminder that was refused (429, or no email on
    // file) still rotated an expired link as a side effect. Renew only once we are
    // actually going to send (renewal — not expiry — is the right behaviour for an
    // invoice's link, see renew-invoice-token.ts; a click landing in the gap between
    // the old token dying and the daily cron must not resend a broken link).
    if (!invoice.projects?.clients?.email)
      return NextResponse.json({ error: 'This client has no email address on file.' }, { status: 400 })
    let token = invoice.token
    const renewal = await renewInvoiceTokenIfExpired(service, id, session.workspaceId, invoice.status, invoice.expires_at)
    if (renewal.renewed && renewal.token) token = renewal.token

    const project   = invoice.projects
    const client    = project?.clients
    const workspace = project?.workspaces
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${token}`
    const balanceDue = Math.max(0, Math.round((Number(invoice.amount) - Number(invoice.amount_paid)) * 100) / 100)

    // FIX (re-audit, notifications section): same check-then-act race as
    // co/[id]/remind and sow/[id]/remind — logging the reminder here,
    // before the send, shrinks the window instead of leaving it open for
    // the full email round-trip. See those routes for the full note.
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'reminder.sent', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
      metadata: { type: 'invoice', client_email: client?.email, balance_due: balanceDue },
    })

    // NOTE (section-12 re-audit — cosmetic): a `!client?.email` re-check + 'reminder.failed'
    // audit log used to sit here, left over from an earlier version of this route. It was
    // dead code — `client` is the same `invoice.projects.clients` object already confirmed
    // truthy-email at the top of this function (nothing re-fetches it in between), so the
    // branch could never fire. Removed rather than left as a misleading guard.
    const cc = await withPrimaryContactCc(service, project?.client_id, client.email, client.cc_emails, 'invoice')
    const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
    // FIX (invoicing independent pass 21): a manual reminder on an invoice that is not yet due (status 'sent' /
    // 'partially_paid' with a due date today or later) told the client "Due date was <future date>" — the template only
    // switches to "It is due on" for the cron's dueSoon flag, which this route never set. Judged on the client's calendar
    // (client zone, then workspace zone, then UTC), exactly like the cron's due-soon scan.
    const clientTz = client.timezone
    const clientToday = dateStringInZone(isValidTimeZone(clientTz) ? clientTz : workspace?.timezone, new Date())
    const dueInFuture = invoice.status !== 'overdue' && !!invoice.due_date && String(invoice.due_date).slice(0, 10) >= clientToday
    const delivery = await checkedSend(() => sendInvoiceReminderEmail({
      to:          client.email,
      cc,
      clientName:  client.name,
      agencyName:  workspace?.agency_name,
      projectName: project?.name,
      invoiceNumber: invoice.invoice_number,
      title:       invoice.title,
      balanceDue,
      currency:    invoice.currency,
      dueDate:     invoice.due_date,
      portalUrl,
      brandColour: workspace?.brand_colour,
      isOverdue:   invoice.status === 'overdue',
      dueInFuture,
      paymentInstructions: invoice.payment_instructions,
      paymentTerms: client.payment_terms_note || null,
      replyTo,
      log:         { workspaceId: session.workspaceId, kind: 'invoice.reminder', entityType: 'invoice', entityId: id, projectId: project?.id, actorId: session.id },
    }), 'Invoice reminder', { requireRecipient: true })
    if (!delivery.ok) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'reminder.failed', entityType: 'invoice', entityId: id, entityName: invoice.title,
        metadata: { type: 'invoice', error: delivery.error },
      })
      return NextResponse.json({
        error: 'The reminder email could not be delivered. Check the client\'s email address and try again.',
        detail: delivery.error,
      }, { status: 502 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice reminder error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
