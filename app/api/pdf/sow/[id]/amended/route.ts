export const runtime = 'nodejs'

// GET /api/pdf/sow/[id]/amended
//
// The AMENDED COPY of a signed SOW: a read-only reference PDF that restates the signed SOW together with the change orders accepted
// since (revised contract value, revised delivery date, added deliverables, exclusions brought into scope). It is derived on request
// and never stored over anything: the signed SOW and every signed change order stay exactly as executed and remain the binding
// documents (lib/documents/conformed-sow.ts).

import { isUuidString } from '@/lib/utils/uuid'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sowRetainerTerms } from '@/lib/sow/retainer'
import { getSession, hasPermission } from '@/lib/auth/session'
import { renderSowPdf } from '@/lib/pdf/renderer'
import { canReadProject } from '@/lib/utils/project-access'
import { hydrateSections } from '@/lib/sow/sections'
import { netOfTax } from '@/lib/documents/tax-basis'
import {
  annotateBroughtIntoScope, conformedDeliverableRows, latestRevisedDate, longDate, revisedContractValue, timelineText,
  type ConformedCo,
} from '@/lib/documents/conformed-sow'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!hasPermission(session, 'VIEW_FINANCIALS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow, error: sowErr } = await (service as any)
      .from('sow_documents')
      .select(`id, version, document_number, sections, metadata, status, project_id,
        projects(id, name, disc, contract_value, currency, type, retainer_duration_months,
          clients(name, company_name, billing_address, vat_number),
          workspaces(timezone, agency_name, brand_colour, logo_storage_path,
            legal_address, tax_id, phone, website))`)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()
    if (sowErr) throw new Error(`SOW read failed: ${sowErr.message}`)
    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.status !== 'signed')
      return NextResponse.json({ error: 'An amended copy is only available for a signed SOW.' }, { status: 409 })
    if (sowRetainerTerms(sow.projects).isRetainer)
      return NextResponse.json({ error: 'An amended copy is available for fixed-fee projects. A retainer is amended by renewing its rate.' }, { status: 409 })

    const { data: amendRows, error: amendErr } = await (service as any)
      .from('amendments')
      .select(`added_deliverables, removed_deliverables, financial_impact, effective_at,
        change_orders(document_number, title, accepted_at, timeline_impact_days, revised_delivery_date, scope_impact_note, is_retainer_renewal)`)
      .eq('project_id', sow.project_id)
      .eq('signed_sow_id', sow.id)
      .order('effective_at', { ascending: true })
    if (amendErr) throw new Error(`Amendments read failed: ${amendErr.message}`)

    const cos: ConformedCo[] = (amendRows || []).map((a: any) => {
      const co = Array.isArray(a.change_orders) ? a.change_orders[0] : a.change_orders
      return {
        number: co?.document_number || null,
        title: String(co?.title || 'Change order'),
        acceptedAt: co?.accepted_at || a.effective_at || null,
        netImpact: Number(a.financial_impact) || 0,
        timelineDays: co?.timeline_impact_days ?? null,
        revisedDeliveryDate: co?.revised_delivery_date || null,
        scopeNote: co?.scope_impact_note || null,
        addedDeliverables: Array.isArray(a.added_deliverables) ? a.added_deliverables : [],
        removedDeliverables: Array.isArray(a.removed_deliverables) ? a.removed_deliverables : [],
        isRenewal: !!co?.is_retainer_renewal,
      }
    })
    if (!cos.length)
      return NextResponse.json({ error: 'This SOW has no accepted change orders, so there is no amended copy. The signed SOW is current.' }, { status: 409 })

    const ws = sow.projects?.workspaces
    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    // Money. Change orders are recorded net of tax. A fee the SOW states tax-inclusive is netted first so every figure here is
    // pre-tax and the amended copy never adds tax to a number that already contains it.
    const taxRate = Number(sow.metadata?.taxRate) > 0 ? Number(sow.metadata.taxRate) : null
    const taxInclusive = sow.metadata?.taxInclusive === true
    const storedValue = Number(sow.projects?.contract_value) || 0
    const originalNet = taxRate ? netOfTax(storedValue, { taxRate, taxInclusive }) : storedValue
    const revisedNet = revisedContractValue(originalNet, cos)
    const revisedGross = taxRate ? round2(revisedNet * (1 + taxRate / 100)) : null

    const sections = hydrateSections(sow.sections || [], sow.metadata).map((sec: any) => {
      if (sec.id === 'deliverables' && Array.isArray(sec.table)) return { ...sec, table: conformedDeliverableRows(sec.table, cos) }
      if (sec.id === 'oos') return { ...sec, content: annotateBroughtIntoScope(String(sec.content || ''), cos) }
      return sec
    })

    const latest = latestRevisedDate(cos)
    const pdf = await renderSowPdf({
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
      contractValue: revisedNet,
      isRetainer: false,
      retainerMonths: null,
      currency:      sow.projects?.currency || 'USD',
      sections,
      language:      sow.metadata?.language || 'en',
      msaReference:  sow.metadata?.msaReference || null,
      paymentStructure: sow.metadata?.paymentStructure || '50_50',
      taxRate,
      // Every figure on the amended copy is pre-tax, so the header always says "excl. tax".
      taxInclusive:  taxRate ? false : null,
      version:       sow.version,
      isWatermarked: true,
      watermarkText: 'AMENDED COPY',
      documentNumber: sow.document_number || null,
      amended: {
        originalValue: originalNet,
        revisedGross,
        revisedDeliveryDate: latest ? longDate(latest) : null,
        amendments: cos.map(c => ({
          ref: c.number || 'CO', title: c.title, acceptedAt: c.acceptedAt, value: c.isRenewal ? 0 : c.netImpact, timeline: timelineText(c),
        })),
      },
    })

    const base = String(sow.document_number || 'SOW').replace(/[^A-Za-z0-9._-]+/g, '-')
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${base}-amended-copy.pdf"`,
        'Content-Length':      String(pdf.length),
        'Cache-Control':       'private, no-cache',
      },
    })
  } catch (err) {
    console.error('Amended SOW PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
