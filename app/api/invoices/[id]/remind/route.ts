export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInvoiceReminderEmail } from '@/lib/email/templates'
import { canReadProject } from '@/lib/utils/project-access'
import { checkReminderCooldown } from '@/lib/utils/reminder-cooldown'

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
      .select(`id, title, amount, amount_paid, currency, status, due_date, token, invoice_number, project_id, payment_instructions,
        projects(id, name, clients(name, email, cc_emails), workspaces(agency_name, brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!['sent', 'partially_paid', 'overdue'].includes(invoice.status))
      return NextResponse.json({ error: 'Can only remind on unpaid, sent invoices' }, { status: 400 })
    if (!invoice.token)
      return NextResponse.json({ error: 'No portal link found — resend the invoice' }, { status: 400 })

    // FIX (re-audit): no cooldown existed at all — an agency user could
    // spam this button and spam the client's inbox with no rate limit.
    const cooldown = await checkReminderCooldown(service, 'invoice', id)
    if (!cooldown.allowed) return NextResponse.json({ error: cooldown.message }, { status: 429 })

    const project   = invoice.projects
    const client    = project?.clients
    const workspace = project?.workspaces
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${invoice.token}`
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
      await sendInvoiceReminderEmail({
        to:          client?.email,
        cc:          client?.cc_emails || [],
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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
