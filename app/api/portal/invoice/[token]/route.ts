export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { formatAddress } from '@/lib/utils/format'

// GET /api/portal/invoice/[token] — read-only. No pay button, no checkout
// flow: this is a document-delivery + status view, not a payment processor.
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()

    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('id').eq('token', token).single()
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    // FIX (doc-completeness audit, finding #3): this query never selected
    // agency legal_address/tax_id/phone/website, client
    // billing_address/vat_number, po_number, or milestone_id — so the
    // page a client actually views (and would file this invoice from) was
    // missing details the PDF (generated from a separate, more complete
    // query in app/api/pdf/invoice/[id]/route.ts) already had. Mirrors the
    // fix already applied to the SOW and CO portal routes.
    // FIX (section-12 audit, flagship finding): sow_id/co_id/line_items
    // weren't selected here either — this is the page a client actually
    // lands on when they open their invoice link (before ever reaching
    // the PDF), and it never showed the itemized breakdown for an
    // itemized invoice, nor which SOW/CO the invoice was billed against.
    // Both /api/pdf/invoice/[id] and /api/portal/invoice/[token]/pdf
    // already select and render all three; this on-screen view was the
    // one place that document was less complete than its own PDF.
    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, amount_paid, currency, status, due_date, sent_at,
        payment_instructions, invoice_number, po_number, project_id, milestone_id, workspace_id,
        subtotal, tax_rate, tax_inclusive, line_items, sow_id, co_id, first_viewed_at, disputed_at, dispute_note,
        projects(id, name, clients(name, company_name, billing_address, vat_number),
          workspaces(agency_name, brand_colour, logo_storage_path,
            legal_address, tax_id, phone, website)),
        sow_documents(document_number), change_orders(document_number, title)`)
      .eq('token', token).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
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

    // FEATURE (portal audit, section 18): first time this invoice is
    // actually opened — mirrors the identical fix on the SOW and CO portal
    // routes. Must never block the response below if the write fails.
    if (!invoice.first_viewed_at) {
      try {
        await (service as any).from('invoices')
          .update({ first_viewed_at: new Date().toISOString() })
          .eq('id', invoice.id).is('first_viewed_at', null)
      } catch (e) { console.error('Invoice first-view tracking failed (non-fatal):', e) }
    }

    let logoUrl: string | null = null
    if (workspace?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(workspace.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    // FIX (doc-completeness audit, finding #3): milestone trigger text
    // and contract position were already shown on the PDF (Phase 11) but
    // never surfaced here — mirrors app/api/pdf/invoice/[id]/route.ts.
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

    const { data: payments } = await (service as any)
      .from('invoice_payments')
      .select('amount, paid_at, method, reference_note')
      .eq('invoice_id', invoice.id)
      .order('paid_at', { ascending: true })

    return NextResponse.json({
      invoice: {
        id: invoice.id,
        title: invoice.title,
        amount: invoice.amount,
        amountPaid: invoice.amount_paid,
        subtotal: invoice.subtotal,
        taxRate: invoice.tax_rate,
        taxInclusive: invoice.tax_inclusive,
        currency: invoice.currency,
        status: invoice.status,
        dueDate: invoice.due_date,
        sentAt: invoice.sent_at,
        paymentInstructions: invoice.payment_instructions,
        invoiceNumber: invoice.invoice_number,
        poNumber: invoice.po_number || null,
        milestoneTrigger,
        contractPosition,
        // FIX (section-12 audit, flagship finding): see the select() fix
        // above — the page component now renders these the same way the
        // PDF does.
        sowNumber: invoice.sow_documents?.document_number || null,
        coNumber:  invoice.change_orders?.document_number || null,
        coTitle:   invoice.change_orders?.title || null,
        // FEATURE (portal audit, section 18): expose the new dispute state
        // so the portal page can show "you already flagged this" instead
        // of re-offering the dispute form.
        disputedAt: invoice.disputed_at || null,
        disputeNote: invoice.dispute_note || null,
        lineItems: typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : (invoice.line_items || []),
        projectName: invoice.projects?.name,
        clientName: invoice.projects?.clients?.name,
        clientCompany: invoice.projects?.clients?.company_name,
        clientBillingAddress: formatAddress(invoice.projects?.clients?.billing_address) || null,
        clientVatNumber: invoice.projects?.clients?.vat_number || null,
        agencyName: workspace?.agency_name,
        // FIX (bug — React error #31, same root cause as the SOW portal route)
        agencyAddress: formatAddress(workspace?.legal_address) || null,
        agencyTaxId: workspace?.tax_id || null,
        agencyPhone: workspace?.phone || null,
        agencyWebsite: workspace?.website || null,
        brandColour: workspace?.brand_colour,
        logoUrl,
      },
      payments: payments || [],
    })
  } catch (err) {
    console.error('Portal invoice error:', err)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
