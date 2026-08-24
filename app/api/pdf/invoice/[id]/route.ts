export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { renderInvoicePdf } from '@/lib/pdf/renderer'
import { canReadProject } from '@/lib/utils/project-access'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, amount_paid, currency, status, due_date, sent_at,
        payment_instructions, invoice_number, po_number, project_id, milestone_id, sow_id, co_id,
        subtotal, tax_rate, tax_inclusive, line_items,
        projects(id, name, clients(name, company_name, billing_address, vat_number),
          workspaces(agency_name, brand_colour, logo_storage_path,
            legal_address, tax_id, phone, website)),
        sow_documents(document_number), change_orders(document_number, title)`)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const ws = invoice.projects?.workspaces

    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const { data: payments } = await (service as any)
      .from('invoice_payments')
      .select('amount, paid_at, method, reference_note')
      .eq('invoice_id', id)
      .order('paid_at', { ascending: true })

    // Milestone trigger text (Phase 11) — shown as a one-line subtitle under
    // the invoice's line item so a reviewer sees *why* this amount was
    // billed ("Upon integration UAT sign-off") without opening the app.
    let milestoneTrigger: string | null = null
    if (invoice.milestone_id) {
      const { data: milestone } = await (service as any)
        .from('payment_milestones').select('trigger').eq('id', invoice.milestone_id).single()
      milestoneTrigger = milestone?.trigger || null
    }

    // Contract position (Phase 11) — most recent reconciliation snapshot for
    // this project. Already computed by the reconciliation-rollup cron for
    // the in-app dashboard; this is the first time it's surfaced on the
    // document itself. Best-effort: a project with no snapshot yet (e.g.
    // reconciliation hasn't run) just omits the block.
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

    const pdfBuffer = await renderInvoicePdf({
      agencyName:   ws?.agency_name || session.agencyName,
      logoUrl,
      brandColour:  ws?.brand_colour || '#1A5C3A',
      agencyAddress: ws?.legal_address || null,
      agencyTaxId:   ws?.tax_id || null,
      agencyPhone:   ws?.phone || null,
      agencyWebsite: ws?.website || null,
      clientName:   invoice.projects?.clients?.name || 'Client',
      clientCompany: invoice.projects?.clients?.company_name || null,
      clientBillingAddress: invoice.projects?.clients?.billing_address || null,
      clientVatNumber:      invoice.projects?.clients?.vat_number || null,
      poNumber:     invoice.po_number || null,
      milestoneTrigger,
      projectName:  invoice.projects?.name || '',
      invoiceNumber: invoice.invoice_number,
      title:        invoice.title,
      amount:       invoice.amount,
      amountPaid:   invoice.amount_paid,
      subtotal:     invoice.subtotal,
      taxRate:      invoice.tax_rate,
      taxInclusive: invoice.tax_inclusive,
      currency:     invoice.currency || 'USD',
      status:       invoice.status,
      dueDate:      invoice.due_date,
      sentAt:       invoice.sent_at,
      paymentInstructions: invoice.payment_instructions,
      sowNumber:  invoice.sow_documents?.document_number || null,
      coNumber:   invoice.change_orders?.document_number || null,
      coTitle:    invoice.change_orders?.title || null,
      lineItems:  typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : (invoice.line_items || []),
      payments:     (payments || []).map((p: any) => ({
        amount: p.amount, paidAt: p.paid_at, method: p.method, referenceNote: p.reference_note,
      })),
      contractPosition,
    })

    const filename = `${invoice.invoice_number || 'Invoice'}-${invoice.projects?.name?.replace(/[^a-z0-9]/gi, '-')}.pdf`

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(pdfBuffer.length),
        'Cache-Control':       'private, no-cache',
      },
    })
  } catch (err) {
    console.error('Invoice PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
