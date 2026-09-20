export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInvoiceReminderEmail } from '@/lib/email/templates'
import { canReadProject } from '@/lib/utils/project-access'
import { checkReminderCooldown } from '@/lib/utils/reminder-cooldown'
import { renewInvoiceTokenIfExpired } from '@/lib/documents/renew-invoice-token'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, amount_paid, currency, status, due_date, token, expires_at, invoice_number, project_id, payment_instructions,
        projects(id, name, client_id, clients(name, email, cc_emails), workspaces(agency_name, brand_colour))`)
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
    let token = invoice.token
    const renewal = await renewInvoiceTokenIfExpired(service, id, session.workspaceId, invoice.status, invoice.expires_at)
    if (renewal.renewed && renewal.token) token = renewal.token

    // FIX (re-audit): no cooldown existed at all — an agency user could
    // spam this button and spam the client's inbox with no rate limit.
    const cooldown = await checkReminderCooldown(service, 'invoice', id)
    if (!cooldown.allowed) return NextResponse.json({ error: cooldown.message }, { status: 429 })

    const project   = invoice.projects
    const client    = project?.clients
    const workspace = project?.workspaces
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${token}`
    const balanceDue = Math.max(0, invoice.amount - invoice.amount_paid)

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

    try {
      // FIX (deep audit, section 14 — traced bug): the initial invoice send
      // (send-invoice.ts) CCs the client's designated primary contact via
      // withPrimaryContactCc, but this reminder — arguably the single most
      // important follow-up email, since it's the one asking to get paid —
      // used to CC only client.cc_emails directly and silently dropped the
      // primary contact. Same gap existed on co/sow remind/withdraw/close,
      // fixed there in the SOW/CO round; this route was outside that
      // round's scope and still had it.
      const cc = await withPrimaryContactCc(service, project?.client_id, client?.email, client?.cc_emails)
      await sendInvoiceReminderEmail({
        to:          client?.email,
        cc,
        clientName:  client?.name,
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
        paymentInstructions: invoice.payment_instructions,
      })
    } catch (e) { console.error('Invoice reminder email failed:', e) }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice reminder error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
