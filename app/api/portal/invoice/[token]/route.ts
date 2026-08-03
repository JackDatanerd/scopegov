export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

// GET /api/portal/invoice/[token] — read-only. No pay button, no checkout
// flow: this is a document-delivery + status view, not a payment processor.
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
        payment_instructions, invoice_number, workspace_id,
        projects(id, name, clients(name, company_name),
          workspaces(agency_name, brand_colour, jwt_secret, logo_storage_path))`)
      .eq('token', token).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (invoice.status === 'draft' || invoice.status === 'void')
      return NextResponse.json({ error: 'This invoice is no longer available' }, { status: 409 })

    const workspace = invoice.projects?.workspaces
    try {
      const secret = new TextEncoder().encode(workspace.jwt_secret)
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

    return NextResponse.json({
      invoice: {
        id: invoice.id,
        title: invoice.title,
        amount: invoice.amount,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        status: invoice.status,
        dueDate: invoice.due_date,
        sentAt: invoice.sent_at,
        paymentInstructions: invoice.payment_instructions,
        invoiceNumber: invoice.invoice_number,
        projectName: invoice.projects?.name,
        clientName: invoice.projects?.clients?.name,
        clientCompany: invoice.projects?.clients?.company_name,
        agencyName: workspace?.agency_name,
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
