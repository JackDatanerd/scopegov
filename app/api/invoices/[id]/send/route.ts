export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { assignDocumentNumber } from '@/lib/utils/document-number'
import { sendInvoiceEmail } from '@/lib/email/templates'
import { renderInvoicePdf } from '@/lib/pdf/renderer'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { canReadProject } from '@/lib/utils/project-access'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

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

    // FIX (section-12 audit): sow_id/co_id/line_items were never selected
    // here, so the PDF attached to the initial send email always rendered
    // as a plain single-line invoice with no "under SOW No. X / as
    // amended by CO No. Y" cross-reference — even for an itemized
    // invoice, even though the exact same document downloaded later via
    // /api/pdf/invoice/[id] renders the full breakdown correctly. The
    // client's inbox copy and the app's canonical copy were two different
    // documents.
    const { data: invoice, error: fetchErr } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, currency, status, due_date, payment_instructions, invoice_number,
        po_number, milestone_id, project_id, subtotal, tax_rate, tax_inclusive, line_items, sow_id, co_id,
        projects(id, name, client_id, clients(name, email, cc_emails, company_name, billing_address, vat_number),
          workspaces(id, agency_name, brand_colour, logo_storage_path, legal_address, tax_id, phone, website)),
        sow_documents(document_number), change_orders(document_number, title)`)
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
    // FIX (doc-completeness audit, Group E — hard block): an invoice with
    // no due date gives the client no payment deadline at all, and one
    // with no payment instructions gives them an amount owed and no way
    // to actually pay it. Both were previously optional all the way
    // through to send.
    if (!invoice.due_date)
      return NextResponse.json({ error: 'Add a due date before sending this invoice.' }, { status: 400 })
    if (!invoice.payment_instructions?.trim())
      return NextResponse.json({ error: 'Add payment instructions before sending this invoice.' }, { status: 400 })

    // jwt_secret lives in workspace_secrets now, not on workspaces itself —
    // see migration 013.
    const jwtSecret = await getWorkspaceJwtSecret(service, session.workspaceId)
    if (!jwtSecret) return NextResponse.json({ error: 'Workspace signing secret not found' }, { status: 500 })
    const secret    = new TextEncoder().encode(jwtSecret)
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

    // FIX (re-audit, race-condition finding): same missing CAS pattern
    // found and fixed in send-sow.ts / send-co.ts — a double-click (or any
    // other double-invocation) could otherwise both pass the earlier
    // `status !== 'draft'` read and both send, burning two document
    // numbers and emailing the client two different tokens.
    const { data: sent, error: updateErr } = await (service as any).from('invoices').update({
      status:         'sent',
      sent_at:        now,
      token,
      expires_at:     expiresAt.toISOString(),
      invoice_number: invoiceNumber,
      updated_at:     now,
    }).eq('id', id).eq('status', 'draft').select('id').maybeSingle()

    if (updateErr) {
      console.error('Invoice send: update failed', updateErr)
      return NextResponse.json({ error: 'Failed to send invoice' }, { status: 500 })
    }
    if (!sent) {
      return NextResponse.json({ error: 'This invoice was already sent by another action' }, { status: 409 })
    }

    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${token}`

    // FIX (section-12 audit, flagship finding): contractPosition was
    // hardcoded to null here — the one field the earlier sowNumber/
    // coNumber/coTitle/lineItems fix (above) didn't also cover. Both
    // /api/pdf/invoice/[id] (internal re-download) and
    // /api/portal/invoice/[token]/pdf (the client's own portal
    // re-download of this exact invoice) fetch the latest contract-
    // reconciliation snapshot and render a contract-position summary
    // from it; the client's very first copy — the one attached to this
    // email — permanently lacked that section. Same query, verbatim,
    // as the other two routes use.
    let contractPosition: { contractedValue: number; invoicedToDate: number; paidToDate: number } | null = null
    if (invoice.project_id) {
      const { data: snapshot } = await (service as any)
        .from('contract_reconciliation_snapshots')
        .select('contracted_value, invoiced_to_date, paid_to_date')
        .eq('project_id', invoice.project_id)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (snapshot) {
        contractPosition = {
          contractedValue: snapshot.contracted_value || 0,
          invoicedToDate:  snapshot.invoiced_to_date || 0,
          paidToDate:      snapshot.paid_to_date || 0,
        }
      }
    }

    // FIX (doc-completeness audit, finding #4): the initial invoice email
    // was link-only, unlike the SOW/CO signed-confirmation emails which
    // attach the PDF. For SOW/CO the client has to visit the portal
    // anyway to sign, so link-only is defensible there — but many
    // procurement/AP workflows expect and auto-file an actual attached
    // PDF, and a link-only invoice is more likely to get stuck or
    // flagged by spam filtering before anyone ever pays it. Build the
    // same PDF the portal/download endpoint serves and attach it here.
    // Best-effort: if generation fails, the email still sends with the
    // portal link, same fallback pattern used for the CO email below.
    let pdfAttachment: { filename: string; content: string } | undefined
    try {
      let logoUrl: string | null = null
      if (workspace?.logo_storage_path) {
        const { data: u } = await (service as any).storage.from('logos').getPublicUrl(workspace.logo_storage_path)
        logoUrl = u?.publicUrl || null
      }
      let milestoneTrigger: string | null = null
      if (invoice.milestone_id) {
        const { data: milestone } = await (service as any)
          .from('payment_milestones').select('trigger').eq('id', invoice.milestone_id).single()
        milestoneTrigger = milestone?.trigger || null
      }
      const pdfBuffer = await renderInvoicePdf({
        agencyName:    workspace.agency_name || session.agencyName,
        logoUrl,
        brandColour:   workspace.brand_colour || '#1A5C3A',
        agencyAddress: workspace.legal_address || null,
        agencyTaxId:   workspace.tax_id || null,
        agencyPhone:   workspace.phone || null,
        agencyWebsite: workspace.website || null,
        clientName:    client.name,
        clientCompany: client.company_name || null,
        clientBillingAddress: client.billing_address || null,
        clientVatNumber:      client.vat_number || null,
        poNumber:      invoice.po_number || null,
        milestoneTrigger,
        projectName:   project.name,
        invoiceNumber,
        title:         invoice.title,
        amount:        invoice.amount,
        amountPaid:    0,
        subtotal:      invoice.subtotal,
        taxRate:       invoice.tax_rate,
        taxInclusive:  invoice.tax_inclusive,
        currency:      invoice.currency,
        status:        'sent',
        dueDate:       invoice.due_date,
        sentAt:        now,
        paymentInstructions: invoice.payment_instructions,
        // FIX (section-12 audit): these were omitted entirely, unlike the
        // standalone /api/pdf/invoice/[id] download route — see the
        // select() fix above for the full explanation.
        sowNumber:  invoice.sow_documents?.document_number || null,
        coNumber:   invoice.change_orders?.document_number || null,
        coTitle:    invoice.change_orders?.title || null,
        lineItems:  typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : (invoice.line_items || []),
        payments:      [],
        contractPosition,
      })
      pdfAttachment = { filename: `${invoiceNumber || 'Invoice'}-${project.name.replace(/[^a-z0-9]/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }
    } catch (e) { console.error('Invoice PDF generation for email failed (email will send without attachment):', e) }

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
        attachments: pdfAttachment ? [pdfAttachment] : undefined,
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
