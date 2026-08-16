export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { renderInvoicePdf } from '@/lib/pdf/renderer'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

// GET /api/portal/invoice/[token]/pdf — same document as /api/pdf/invoice/[id],
// but gated by the client's portal token instead of an internal session, since
// the client viewing this page is never logged in to ScopeGov.
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()

    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('id').eq('token', token).single()
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, amount_paid, currency, status, due_date, sent_at,
        payment_instructions, invoice_number, po_number, project_id, milestone_id, workspace_id,
        subtotal, tax_rate, tax_inclusive,
        projects(id, name, clients(name, company_name, billing_address, vat_number),
          workspaces(agency_name, brand_colour, logo_storage_path,
            legal_address, tax_id, phone, website))`)
      .eq('token', token).single()

    if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (invoice.status === 'draft' || invoice.status === 'void')
      return NextResponse.json({ error: 'This invoice is no longer available' }, { status: 409 })

    const workspace = invoice.projects?.workspaces
    // jwt_secret lives in workspace_secrets now, not on workspaces itself —
    // see migration 013.
    try {
      const jwtSecret = await getWorkspaceJwtSecret(service, invoice.workspace_id)
      if (!jwtSecret) throw new Error('no secret')
      const secret = new TextEncoder().encode(jwtSecret)
      await jwtVerify(token, secret)
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })
    }

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
