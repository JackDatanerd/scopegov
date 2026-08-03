export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { renderInvoicePdf } from '@/lib/pdf/renderer'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, amount_paid, currency, status, due_date, sent_at,
        payment_instructions, invoice_number,
        projects(id, name, clients(name, company_name),
          workspaces(agency_name, brand_colour, logo_storage_path))`)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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

    const pdfBuffer = await renderInvoicePdf({
      agencyName:   ws?.agency_name || session.agencyName,
      logoUrl,
      brandColour:  ws?.brand_colour || '#1A5C3A',
      clientName:   invoice.projects?.clients?.name || 'Client',
      clientCompany: invoice.projects?.clients?.company_name || null,
      projectName:  invoice.projects?.name || '',
      invoiceNumber: invoice.invoice_number,
      title:        invoice.title,
      amount:       invoice.amount,
      amountPaid:   invoice.amount_paid,
      currency:     invoice.currency || 'USD',
      status:       invoice.status,
      dueDate:      invoice.due_date,
      sentAt:       invoice.sent_at,
      paymentInstructions: invoice.payment_instructions,
      payments:     (payments || []).map((p: any) => ({
        amount: p.amount, paidAt: p.paid_at, method: p.method, referenceNote: p.reference_note,
      })),
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
