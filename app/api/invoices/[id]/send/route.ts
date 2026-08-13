export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { assignDocumentNumber } from '@/lib/utils/document-number'
import { sendInvoiceEmail } from '@/lib/email/templates'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })
    if (!session.emailVerifiedAt)
      return NextResponse.json({ error: 'Please verify your email before sending invoices' }, { status: 403 })

    const service = createServiceClient()

    const { data: invoice, error: fetchErr } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, currency, status, due_date, payment_instructions, invoice_number,
        projects(id, name, client_id, clients(name, email, cc_emails, company_name),
          workspaces(id, agency_name, brand_colour, jwt_secret))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) {
      console.error('Invoice send: lookup failed', { id, workspaceId: session.workspaceId, error: fetchErr })
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (!(await canReadProject(service, session, invoice.projects?.id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status !== 'draft')
      return NextResponse.json({ error: 'Only draft invoices can be sent' }, { status: 400 })

    const project   = invoice.projects
    const client    = project?.clients
    const workspace = project?.workspaces

    if (!client?.email)
      return NextResponse.json({ error: 'Client email required' }, { status: 400 })

    const secret    = new TextEncoder().encode(workspace.jwt_secret)
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) // invoices stay viewable longer than SOW/CO response windows
    const token     = await new SignJWT({
      invoiceId:   id,
      workspaceId: session.workspaceId,
      projectId:   project.id,
      clientEmail: client.email,
      action:      'view',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(expiresAt)
      .setJti(nanoid())
      .sign(secret)

    const now = new Date().toISOString()

    // Phase 0: assign sequential document number at send.
    const invoiceNumber = invoice.invoice_number || await assignDocumentNumber(service, session.workspaceId, 'invoice')

    const { error: updateErr } = await (service as any).from('invoices').update({
      status:         'sent',
      sent_at:        now,
      token,
      expires_at:     expiresAt.toISOString(),
      invoice_number: invoiceNumber,
      updated_at:     now,
    }).eq('id', id)

    if (updateErr) {
      console.error('Invoice send: update failed', updateErr)
      return NextResponse.json({ error: 'Failed to send invoice' }, { status: 500 })
    }

    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${token}`
    try {
      await sendInvoiceEmail({
        to:          client.email,
        cc:          client.cc_emails || [],
        clientName:  client.name,
        agencyName:  workspace.agency_name,
        projectName: project.name,
        invoiceNumber,
        title:       invoice.title,
        amount:      invoice.amount,
        currency:    invoice.currency,
        dueDate:     invoice.due_date,
        portalUrl,
        brandColour: workspace.brand_colour,
        paymentInstructions: invoice.payment_instructions,
      })
    } catch (e) { console.error('Invoice email failed:', e) }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.sent', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
      metadata: { amount: invoice.amount, client_email: client.email, invoice_number: invoiceNumber },
    })

    return NextResponse.json({ ok: true, token, portalUrl, invoiceNumber })
  } catch (err) {
    console.error('Invoice send error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
