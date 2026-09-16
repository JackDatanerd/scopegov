export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { renderCoPdf } from '@/lib/pdf/renderer'
import { canReadProject } from '@/lib/utils/project-access'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id, title, note, version, status, document_number, line_items, subtotal, tax_rate, tax_inclusive, total,
        timeline_impact_days, scope_impact_note,
        accepted_at, accepted_by, client_signature_data, project_id,
        projects(id, name, currency, contract_value,
          clients(name, company_name, billing_address, vat_number),
          workspaces(agency_name, brand_colour, logo_storage_path, agency_signature_data,
            legal_address, tax_id, phone, website))`)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const ws = co.projects?.workspaces
    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const lineItems = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])

    // "Amends SOW No. X" — change_orders has no direct FK to sow_documents,
    // so this is resolved from the project's current signed SOW. Best
    // effort: a project with no signed SOW on file (shouldn't normally
    // happen for a project that has change orders, but not enforced at
    // the DB level) just omits the cross-reference line.
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('document_number')
      .eq('project_id', co.project_id)
      .eq('status', 'signed')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    // contractValueBefore: see the CoPdfData doc comment in
    // lib/pdf/renderer.tsx for the known limitation with out-of-order
    // historical change orders.
    const contractValueBefore = co.projects?.contract_value != null
      ? co.projects.contract_value - (co.status === 'accepted' ? (co.total || 0) : 0)
      : null

    const pdfBuffer = await renderCoPdf({
      agencyName:  ws?.agency_name || session.agencyName,
      logoUrl,
      brandColour: ws?.brand_colour || '#1A5C3A',
      agencyAddress: ws?.legal_address || null,
      agencyTaxId:   ws?.tax_id || null,
      agencyPhone:   ws?.phone || null,
      agencyWebsite: ws?.website || null,
      clientName:  co.projects?.clients?.name || 'Client',
      clientCompany: co.projects?.clients?.company_name || null,
      clientBillingAddress: co.projects?.clients?.billing_address || null,
      clientVatNumber:      co.projects?.clients?.vat_number || null,
      projectName: co.projects?.name || '',
      coTitle:     co.title,
      note:        co.note,
      lineItems,
      subtotal:    co.subtotal || 0,
      taxRate:     co.tax_rate || 0,
      taxInclusive: co.tax_inclusive || false,
      total:       co.total || 0,
      currency:    co.projects?.currency || 'USD',
      status:      co.status,
      // FIX (re-audit): CoDocument had no watermark support at all — a
      // draft CO previewed from CoEditor before ever being sent was
      // visually identical to a final, client-signed one.
      // FIX (section-10 audit): narrowing to only 'draft' meant a CO in
      // 'awaiting_response', 'countered', 'stalled', or
      // 'awaiting_countersignature' — none of them final — downloaded
      // internally had NO watermark either, indistinguishable from a
      // truly accepted CO if forwarded externally. The identical bug was
      // already fixed on the SOW PDF route (`sow.status !== 'signed'`);
      // this carries the same fix over: watermark anything that isn't
      // yet accepted.
      isWatermarked: co.status !== 'accepted',
      acceptedBy:  co.accepted_by || undefined,
      acceptedAt:  co.accepted_at || undefined,
      agencySignatureData: ws?.agency_signature_data || null,
      clientSignatureData: co.client_signature_data || null,
      documentNumber: co.document_number || null,
      sowNumber:   sow?.document_number || null,
      contractValueBefore,
      timelineImpactDays: co.timeline_impact_days ?? null,
      scopeImpactNote:    co.scope_impact_note || null,
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
