export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInvoiceReminderEmail } from '@/lib/email/templates'

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
      .select(`id, title, amount, amount_paid, currency, status, due_date, token, invoice_number,
        projects(id, name, clients(name, email, cc_emails), workspaces(agency_name, brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!['sent', 'partially_paid', 'overdue'].includes(invoice.status))
      return NextResponse.json({ error: 'Can only remind on unpaid, sent invoices' }, { status: 400 })
    if (!invoice.token)
      return NextResponse.json({ error: 'No portal link found — resend the invoice' }, { status: 400 })

    const project   = invoice.projects
    const client    = project?.clients
    const workspace = project?.workspaces
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${invoice.token}`
    const balanceDue = Math.max(0, invoice.amount - invoice.amount_paid)

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
      })
    } catch (e) { console.error('Invoice reminder email failed:', e) }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'reminder.sent', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
      metadata: { type: 'invoice', client_email: client?.email, balance_due: balanceDue },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
