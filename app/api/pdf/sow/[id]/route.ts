export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { renderSowPdf, resolveLogoDataUri } from '@/lib/pdf/renderer'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, sections, metadata, status, signed_at, signed_by, client_signature_data,
        projects(id, name, disc, contract_value, currency,
          clients(name),
          workspaces(agency_name, brand_colour, logo_storage_path, agency_signature_data))`)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const ws = sow.projects?.workspaces

    // Get logo URL
    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const pdfBuffer = await renderSowPdf({
      agencyName:    ws?.agency_name || session.agencyName,
      agencyLogoUrl: logoUrl,
      brandColour:   ws?.brand_colour || '#1A5C3A',
      clientName:    sow.projects?.clients?.name || 'Client',
      projectName:   sow.projects?.name + (sow.projects?.disc ? ` — ${sow.projects.disc}` : ''),
      contractValue: sow.projects?.contract_value || 0,
      currency:      sow.projects?.currency || 'USD',
      sections:      sow.sections || [],
      signedBy:      sow.signed_by || undefined,
      signedAt:      sow.signed_at || undefined,
      agencySignatureData: ws?.agency_signature_data || null,
      clientSignatureData: sow.client_signature_data || null,
      version:       sow.version,
      isWatermarked: sow.status === 'draft',
    })

    const filename = `SOW-${sow.projects?.name?.replace(/[^a-z0-9]/gi, '-')}-v${sow.version}.pdf`

    // BUG-008: return Uint8Array to satisfy NextResponse BodyInit
    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(pdfBuffer.length),
        'Cache-Control':       'private, no-cache',
      },
    })
  } catch (err) {
    console.error('SOW PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
