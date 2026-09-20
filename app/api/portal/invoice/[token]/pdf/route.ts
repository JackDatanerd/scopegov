export const runtime = 'nodejs'

import { computeContractPosition } from '@/lib/reports/contract-position'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { renderInvoicePdf } from '@/lib/pdf/renderer'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'
import { resolveInvoiceToken } from '@/lib/documents/invoice-token'

// GET /api/portal/invoice/[token]/pdf — same document as /api/pdf/invoice/[id],
// but gated by the client's portal token instead of an internal session, since
// the client viewing this page is never logged in to ScopeGov.
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()
    // Read-only but CPU-heavy: throttle per IP so a loop of PDF requests can't burn function time.
    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'invoice.pdf')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'invoice.pdf')

    const resolved = await resolveInvoiceToken(service, token, `id, title, amount, amount_paid, currency, status, due_date, sent_at,
        payment_instructions, invoice_number, po_number, project_id, milestone_id, sow_id, co_id, workspace_id,
        subtotal, tax_rate, tax_inclusive, line_items,
        projects(id, name, clients(name, company_name, billing_address, vat_number),
          workspaces(agency_name, brand_colour, logo_storage_path,
            legal_address, tax_id, phone, website)),
        sow_documents(document_number), change_orders(document_number, title)`)
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    const invoice = resolved.invoice
    const workspace = invoice.projects?.workspaces

    let logoUrl: string | null = null
    if (workspace?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(workspace.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const { data: payments } = await (service as any)
      .from('invoice_payments')
      .select('amount, paid_at, method, reference_note')
      .eq('invoice_id', invoice.id)
      .order('paid_at', { ascending: true })

    // Same two Phase-11 lookups as the internal /api/pdf/invoice route —
    // kept in sync so the client-facing portal PDF and the internal one
    // never drift apart.
    let milestoneTrigger: string | null = null
    if (invoice.milestone_id) {
      const { data: milestone } = await (service as any)
        .from('payment_milestones').select('trigger').eq('id', invoice.milestone_id).single()
      milestoneTrigger = milestone?.trigger || null
    }

    // Computed LIVE (lib/reports/contract-position.ts), not read from the nightly snapshot: the snapshot
    // can never include the invoice being rendered right now, and mis-stated retainers.
    let contractPosition: { contractedValue: number; invoicedToDate: number; paidToDate: number } | null = null
    if (invoice.project_id) {
      const position = await computeContractPosition(service, invoice.project_id)
      if (position) contractPosition = { contractedValue: position.contractedValue, invoicedToDate: position.invoicedToDate, paidToDate: position.paidToDate }
    }

    const pdfBuffer = await renderInvoicePdf({
      agencyName:   workspace?.agency_name || 'Agency',
      logoUrl,
      brandColour:  workspace?.brand_colour || '#1A5C3A',
      agencyAddress: workspace?.legal_address || null,
      agencyTaxId:   workspace?.tax_id || null,
      agencyPhone:   workspace?.phone || null,
      agencyWebsite: workspace?.website || null,
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

    const filename = `${invoice.invoice_number || 'Invoice'}.pdf`
    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(pdfBuffer.length),
        'Cache-Control':       'private, no-cache',
      },
    })
  } catch (err) {
    console.error('Portal invoice PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
