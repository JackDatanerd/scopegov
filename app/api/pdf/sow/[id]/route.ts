export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { renderSowPdf, resolveLogoDataUri } from '@/lib/pdf/renderer'
import { canReadProject } from '@/lib/utils/project-access'
import { fetchExecutedPdf } from '@/lib/documents/executed-pdf'
import { hydrateSections } from '@/lib/sow/sections'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // FIX (section-9 re-audit): this route rendered the contract value
    // (and the payment-schedule table, which states it repeatedly) into
    // the PDF with no VIEW_FINANCIALS check — the same data GET
    // /api/sow/[id] already redacts (`contractValue: hasPermission(...)
    // ? value : null`), and the exact gap app/api/pdf/invoice/[id]/route.ts
    // was already fixed for: a document's PDF has to be gated the same as
    // its JSON, or the JSON-side redaction is pure theater.
    if (!hasPermission(session, 'VIEW_FINANCIALS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const service = createServiceClient()

    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, document_number, sections, metadata, status, signed_at, signed_by, client_signature_data, project_id, pdf_path,
        projects(id, name, disc, contract_value, currency,
          clients(name, company_name, billing_address, vat_number),
          workspaces(agency_name, brand_colour, logo_storage_path, agency_signature_data,
            legal_address, tax_id, phone, website))`)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const respond = (buf: Buffer, name: string) => new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length':      String(buf.length),
        'Cache-Control':       'private, no-cache',
      },
    })
    const fileName = `SOW-${sow.projects?.name?.replace(/[^a-z0-9]/gi, '-')}-v${sow.version}.pdf`

    // A signed SOW is served from the copy frozen at signing (lib/documents/executed-pdf.ts) so it
    // cannot change when live rows do. Documents signed before that shipped fall through to a
    // live render.
    if (sow.status === 'signed') {
      const frozen = await fetchExecutedPdf(service, sow.pdf_path)
      if (frozen) return respond(frozen, fileName)
    }

    const ws = sow.projects?.workspaces

    // Get logo URL
    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    // Payment schedule (Phase 11) — payment_milestones already exists per
    // project/SOW and drives the in-app milestone tracker, but was never
    // read for the SOW PDF itself. Ordered by due_date so it reads as a
    // schedule, not an arbitrary list.
    // For a signed SOW (live-render fallback) only the schedule that existed at signing — later
    // retainer-cron rows are billing state, not part of the agreement.
    let milestonesQuery = (service as any)
      .from('payment_milestones')
      .select('title, amount, percentage, trigger, due_date, status')
      .eq('sow_id', id)
    if (sow.status === 'signed' && sow.signed_at)
      milestonesQuery = milestonesQuery.lte('created_at', new Date(new Date(sow.signed_at).getTime() + 10 * 60 * 1000).toISOString())
    const { data: milestones } = await milestonesQuery
      .order('due_date', { ascending: true, nullsFirst: false })

    const pdfBuffer = await renderSowPdf({
      agencyName:    ws?.agency_name || session.agencyName,
      agencyLogoUrl: logoUrl,
      brandColour:   ws?.brand_colour || '#1A5C3A',
      agencyAddress: ws?.legal_address || null,
      agencyTaxId:   ws?.tax_id || null,
      agencyPhone:   ws?.phone || null,
      agencyWebsite: ws?.website || null,
      clientName:    sow.projects?.clients?.name || 'Client',
      clientCompany: sow.projects?.clients?.company_name || null,
      clientBillingAddress: sow.projects?.clients?.billing_address || null,
      clientVatNumber:      sow.projects?.clients?.vat_number || null,
      projectName:   sow.projects?.name + (sow.projects?.disc ? ` — ${sow.projects.disc}` : ''),
      contractValue: sow.projects?.contract_value || 0,
      currency:      sow.projects?.currency || 'USD',
      sections:      hydrateSections(sow.sections || [], sow.metadata),
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
      // FIX (re-audit): only 'draft' was watermarked. An 'awaiting_signature'
      // or 'changes_requested' SOW downloaded internally had no watermark
      // and no signature block, making it visually indistinguishable from a
      // final, signed document if forwarded externally. Watermark anything
      // that isn't yet signed.
      isWatermarked: sow.status !== 'signed',
      documentNumber: sow.document_number || null,
    })

    return respond(pdfBuffer, fileName)
  } catch (err) {
    console.error('SOW PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
