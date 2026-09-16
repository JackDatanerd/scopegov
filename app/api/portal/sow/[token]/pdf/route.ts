export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { renderSowPdf } from '@/lib/pdf/renderer'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

const SOW_PDF_COLUMNS = `id, version, document_number, sections, metadata, status, signed_at, signed_by,
  client_signature_data, workspace_id,
  projects(id, name, disc, contract_value, currency,
    clients(name, company_name, billing_address, vat_number),
    workspaces(agency_name, brand_colour, logo_storage_path, agency_signature_data,
      legal_address, tax_id, phone, website))`

// FIX (audit): no portal-scoped PDF route existed for SOWs at all. The only
// SOW PDF route (/api/pdf/sow/[id]) requires an authenticated internal
// session, so a client on this token-based portal — who is never logged in
// to ScopeGov — had no way to download a copy of the SOW anywhere. This
// mirrors /api/portal/co/[token]/pdf and /api/portal/invoice/[token]/pdf.
//
// Only served once signed: before that there's no finalized document (with
// signatures) to hand out, and the client can already review the unsigned
// sections directly on the portal page itself.
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()

    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('reason, document_id').eq('token', token).single()
    // 'declined'/'withdrawn' still 410 as normal — only a superseded
    // (rotated-on-signature) token gets the id-based fallback below, since
    // that's the only reason that means "this document is fine, just this
    // particular token isn't the current one anymore."
    if (revoked && revoked.reason !== 'superseded')
      return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    let { data: sow } = await (service as any)
      .from('sow_documents').select(SOW_PDF_COLUMNS).eq('token', token).single()

    // FIX (portal audit, section 18 — flagship finding): the sign route
    // rotates sow_documents.token to a fresh value the instant signing
    // completes (step 1b), so the ORIGINAL token — the one in the client's
    // very first "please sign" email, which is also the only token they'd
    // ever use to reach this /pdf route before a rotated one exists — goes
    // dead the moment they actually sign. document_id (migration 029)
    // resolves it back to the live row.
    let skipJwtVerify = false
    if (!sow && revoked?.reason === 'superseded' && revoked.document_id) {
      const { data: byId } = await (service as any)
        .from('sow_documents').select(SOW_PDF_COLUMNS).eq('id', revoked.document_id).single()
      if (byId) { sow = byId; skipJwtVerify = true }
    }

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (sow.status !== 'signed')
      return NextResponse.json({ error: 'This SOW has not been signed yet' }, { status: 409 })

    if (!skipJwtVerify) {
      try {
        const jwtSecret = await getWorkspaceJwtSecret(service, sow.workspace_id)
        if (!jwtSecret) throw new Error('no secret')
        const secret = new TextEncoder().encode(jwtSecret)
        await jwtVerify(token, secret)
      } catch {
        return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })
      }
    }

    const project = sow.projects
    const client  = project?.clients
    const ws      = project?.workspaces

    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const { data: milestones } = await (service as any)
      .from('payment_milestones')
      .select('title, amount, percentage, trigger, due_date, status')
      .eq('sow_id', sow.id)
      .order('due_date', { ascending: true, nullsFirst: false })

    const pdfBuffer = await renderSowPdf({
      agencyName:    ws?.agency_name || 'Agency',
      agencyLogoUrl: logoUrl,
      brandColour:   ws?.brand_colour || '#1A5C3A',
      agencyAddress: ws?.legal_address || null,
      agencyTaxId:   ws?.tax_id || null,
      agencyPhone:   ws?.phone || null,
      agencyWebsite: ws?.website || null,
      clientName:    client?.name || 'Client',
      clientCompany: client?.company_name || null,
      clientBillingAddress: client?.billing_address || null,
      clientVatNumber:      client?.vat_number || null,
      projectName:   (project?.name || '') + (project?.disc ? ` — ${project.disc}` : ''),
      contractValue: project?.contract_value || 0,
      currency:      project?.currency || 'USD',
      sections:      sow.sections || [],
      // FIX (section-9 audit, 9-G7): the document's drafting language,
      // so schema-driven table headers render in it (section titles are
      // already stored localized).
      language:      sow.metadata?.language || 'en',
      // FIX (section-9 audit, 9-G4): `msaReference` has been declared on
      // SowPdfData, rendered under the masthead, and documented as
      // "Sourced from sow_documents.metadata.msaReference" since it was
      // added — while no route ever passed it. A fully dead feature.
      // Wire it to the field its own doc comment names.
      msaReference:  sow.metadata?.msaReference || null,
      paymentSchedule: (milestones || []).map((m: any) => ({
        title: m.title, amount: m.amount, percentage: m.percentage,
        trigger: m.trigger, dueDate: m.due_date, status: m.status,
      })),
      signedBy:      sow.signed_by || undefined,
      signedAt:      sow.signed_at || undefined,
      agencySignatureData: ws?.agency_signature_data || null,
      clientSignatureData: sow.client_signature_data || null,
      version:       sow.version,
      isWatermarked: false,
      documentNumber: sow.document_number || null,
    })

    const filename = `SOW-${(project?.name || 'document').replace(/[^a-z0-9]/gi, '-')}-v${sow.version}.pdf`
    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(pdfBuffer.length),
        'Cache-Control':       'private, no-cache',
      },
    })
  } catch (err) {
    console.error('Portal SOW PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
