export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { renderCoPdf } from '@/lib/pdf/renderer'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id, title, note, version, document_number, line_items, subtotal, tax_rate, tax_inclusive, total,
        accepted_at, accepted_by, status, client_signature_data,
        projects(id, name, currency,
          clients(name),
          workspaces(agency_name, brand_colour, logo_storage_path, agency_signature_data))`)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const ws = co.projects?.workspaces
    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const lineItems = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])

    const pdfBuffer = await renderCoPdf({
      agencyName:  ws?.agency_name || session.agencyName,
      logoUrl,
      brandColour: ws?.brand_colour || '#1A5C3A',
      clientName:  co.projects?.clients?.name || 'Client',
      projectName: co.projects?.name || '',
      coTitle:     co.title,
      note:        co.note,
      lineItems,
      subtotal:    co.subtotal || 0,
      taxRate:     co.tax_rate || 0,
      taxInclusive: co.tax_inclusive || false,
      total:       co.total || 0,
      currency:    co.projects?.currency || 'USD',
      acceptedBy:  co.accepted_by || undefined,
      acceptedAt:  co.accepted_at || undefined,
      agencySignatureData: ws?.agency_signature_data || null,
      clientSignatureData: co.client_signature_data || null,
      documentNumber: co.document_number || null,
    })

    const filename = `CO-${co.title.replace(/[^a-z0-9]/gi, '-')}.pdf`

    // BUG-008: Uint8Array for NextResponse BodyInit
    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control':       'private, no-cache',
      },
    })
  } catch (err) {
    console.error('CO PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
