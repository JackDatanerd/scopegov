export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { renderCoPdf } from '@/lib/pdf/renderer'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { getContractValueBefore } from '@/lib/documents/co-contract-value'

// FIX (doc-completeness audit, finding #9): no portal-scoped PDF route
// existed for change orders at all — a client who accepted a CO had no
// self-service way to re-download it later; the only copy they'd ever
// see was a one-time email attachment. This mirrors
// /api/portal/invoice/[token]/pdf.
//
// One wrinkle unique to COs: the token a client used to accept is
// immediately marked revoked (reason: 'superseded') so it can't be
// replayed to accept/decline/counter again — but that same revocation
// would also block this read-only PDF route if treated like any other
// revocation. So: a 'superseded' token on a CO that is now 'accepted' is
// still valid for GETting the PDF; anything else revoked (declined,
// withdrawn) still 410s as normal.
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()

    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('reason, document_id').eq('token', token).single()

    const CO_PDF_COLUMNS = `id,title,note,status,line_items,subtotal,tax_rate,tax_inclusive,total,
        timeline_impact_days,scope_impact_note,
        document_number,accepted_by,accepted_at,client_signature_data,workspace_id,project_id,
        projects(id,name,currency,contract_value,clients(name,email,company_name,billing_address,vat_number),
          workspaces(id,agency_name,brand_colour,logo_storage_path,agency_signature_data,
            legal_address,tax_id,phone,website))`

    let { data: co } = await (service as any)
      .from('change_orders').select(CO_PDF_COLUMNS).eq('token', token).single()

    // FIX (portal audit, section 18): same root cause as
    // app/api/portal/co/[token]/route.ts — accept/countersign rotate
    // change_orders.token on completion, which orphans this exact token
    // (the one that WAS used to accept, per the comment above) the moment
    // acceptance finishes. document_id (migration 029) resolves it back
    // to the live row.
    let skipJwtVerify = false
    if (!co && revoked?.reason === 'superseded' && revoked.document_id) {
      const { data: byId } = await (service as any)
        .from('change_orders').select(CO_PDF_COLUMNS).eq('id', revoked.document_id).single()
      if (byId) { co = byId; skipJwtVerify = true }
    }

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const readOnlyAllowed = revoked?.reason === 'superseded' && co.status === 'accepted'
    if (revoked && !readOnlyAllowed) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })
    if (co.status !== 'accepted')
      return NextResponse.json({ error: 'This change order has not been accepted yet' }, { status: 409 })

    if (!skipJwtVerify) {
      try {
        const jwtSecret = await getWorkspaceJwtSecret(service, co.workspace_id)
        if (!jwtSecret) throw new Error('no secret')
        const secret = new TextEncoder().encode(jwtSecret)
        await jwtVerify(token, secret)
      } catch {
        return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })
      }
    }

    const project = co.projects
    const client  = project?.clients
    const ws      = project?.workspaces

    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const lineItems = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])

    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('document_number')
      .eq('project_id', co.project_id)
      .eq('status', 'signed')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    const contractValueBefore = await getContractValueBefore(
      service, co.project_id, co.id, project?.contract_value ?? null
    )

    const pdfBuffer = await renderCoPdf({
      agencyName:    ws?.agency_name || 'Agency',
      logoUrl,
      brandColour:   ws?.brand_colour || '#1A5C3A',
      agencyAddress: ws?.legal_address || null,
      agencyTaxId:   ws?.tax_id || null,
      agencyPhone:   ws?.phone || null,
      agencyWebsite: ws?.website || null,
      clientName:    client?.name || 'Client',
      clientCompany: client?.company_name || null,
      clientBillingAddress: client?.billing_address || null,
      clientVatNumber:      client?.vat_number || null,
      projectName:   project?.name || '',
      coTitle:       co.title,
      note:          co.note || null,
      lineItems,
      subtotal:      co.subtotal,
      taxRate:       co.tax_rate,
      taxInclusive:  co.tax_inclusive,
      total:         co.total,
      currency:      project?.currency || 'USD',
      status:        co.status,
      acceptedBy:    co.accepted_by,
      acceptedAt:    co.accepted_at,
      agencySignatureData: ws?.agency_signature_data || null,
      clientSignatureData: co.client_signature_data || null,
      documentNumber: co.document_number || null,
      sowNumber:     sow?.document_number || null,
      contractValueBefore,
      timelineImpactDays: co.timeline_impact_days ?? null,
      scopeImpactNote:    co.scope_impact_note || null,
    })

    const filename = `${co.document_number || 'CO'}.pdf`
    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(pdfBuffer.length),
        'Cache-Control':       'private, no-cache',
      },
    })
  } catch (err) {
    console.error('Portal CO PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
