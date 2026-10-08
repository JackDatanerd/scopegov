export const runtime = 'nodejs'

import { isUuidString } from '@/lib/utils/uuid'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sowRetainerTerms } from '@/lib/sow/retainer'
import { getSession, hasPermission } from '@/lib/auth/session'
import { renderSowPdf, resolveLogoDataUri } from '@/lib/pdf/renderer'
import { canReadProject } from '@/lib/utils/project-access'
import { fetchExecutedPdf } from '@/lib/documents/executed-pdf'
import { hydrateSections } from '@/lib/sow/sections'
import { sowPdfFilename } from '@/lib/documents/sow-pdf-name'
import { sowWatermarkLabel } from '@/lib/pdf/sow-watermark'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // FIX (SOW lifecycle independent pass 16, B2): a malformed id reached the query as invalid uuid text (Postgres 22P02),
    // which the read-failure branch below turned into a logged 500 "PDF generation failed". It is simply not found.
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
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

    const { data: sow, error: sowReadErr } = await (service as any)
      .from('sow_documents')
      .select(`id, version, document_number, sections, metadata, status, signed_at, signed_by, signer_title, signer_company, client_signature_data, project_id, pdf_path,
        projects(id, name, disc, contract_value, currency, type, retainer_duration_months,
          clients(name, company_name, billing_address, vat_number),
          workspaces(timezone, agency_name, brand_colour, logo_storage_path, agency_signature_data, agency_signatory_name, agency_signatory_title,
            legal_address, tax_id, phone, website))`)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()
    // FIX (SOW lifecycle independent pass 15, B4): a failed read is not "not found" — fail into the route's 500 handler.
    if (sowReadErr) throw new Error(`SOW read failed: ${sowReadErr.message}`)

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
    const fileName = sowPdfFilename(sow.projects?.name, sow.version, sow.document_number)

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
      timeZone: ws?.timezone,
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
      // B1 (pass 10): a retainer's stored value is the monthly fee — see lib/sow/retainer.ts.
      isRetainer:     sowRetainerTerms(sow.projects).isRetainer,
      retainerMonths: sowRetainerTerms(sow.projects).months,
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
      // createSowMilestones() defaults a missing structure to 50_50; mirror that so the milestone block is only
      // used when the agreement really is a milestone one (renderer.tsx, SOW lifecycle round 8 B3).
      paymentStructure: sow.metadata?.paymentStructure || '50_50',
      taxRate:       Number(sow.metadata?.taxRate) > 0 ? Number(sow.metadata.taxRate) : null,
      taxInclusive:  typeof sow.metadata?.taxInclusive === 'boolean' ? sow.metadata.taxInclusive : null,
      paymentSchedule: (milestones || []).map((m: any) => ({
        title: m.title, amount: m.amount, percentage: m.percentage,
        trigger: m.trigger, dueDate: m.due_date, status: m.status,
      })),
      signedBy:      sow.signed_by || undefined,
      clientSignerTitle:   sow.signer_title || null,
      clientSignerCompany: sow.signer_company || null,
      signedAt:      sow.signed_at || undefined,
      agencySignatureData: ws?.agency_signature_data || null,
      agencySignatoryName: ws?.agency_signatory_name || null,
      agencySignatoryTitle: ws?.agency_signatory_title || null,
      clientSignatureData: sow.client_signature_data || null,
      version:       sow.version,
      // FIX (re-audit): only 'draft' was watermarked. An 'awaiting_signature'
      // or 'changes_requested' SOW downloaded internally had no watermark
      // and no signature block, making it visually indistinguishable from a
      // final, signed document if forwarded externally. Watermark anything
      // that isn't yet signed.
      isWatermarked: sow.status !== 'signed',
      watermarkText: sowWatermarkLabel(sow.status) ?? undefined,
      documentNumber: sow.document_number || null,
    })

    return respond(pdfBuffer, fileName)
  } catch (err) {
    console.error('SOW PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
