export const runtime = 'nodejs'

import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { renderSowPdf } from '@/lib/pdf/renderer'
import { getWorkspaceJwtSecret, isWorkspaceDeleted } from '@/lib/utils/workspace-secret'
import { fetchExecutedPdf } from '@/lib/documents/executed-pdf'
import { hydrateSections } from '@/lib/sow/sections'

const SOW_PDF_COLUMNS = `id, version, document_number, sections, metadata, status, signed_at, signed_by,
  client_signature_data, workspace_id, pdf_path,
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
    // Read-only but CPU-heavy: throttle per IP so a loop of PDF requests can't burn function time.
    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'sow.pdf')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'sow.pdf')

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
    // A signed SOW serves its frozen executed copy. A SOW still awaiting signature serves a
    // watermarked, unsigned REVIEW copy — clients routinely need to pass the document to counsel
    // or a finance team before anyone signs, and the portal offered no way to get a file.
    const isSigned = sow.status === 'signed'
    if (!isSigned && sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'This SOW is not available as a PDF' }, { status: 409 })

    // FIX (portal audit, section 18 re-pass): every other portal route
    // (GET/route.ts, sign, decline, request-changes) checks isWorkspaceDeleted
    // right after the document's workspace_id is known — see that function's
    // own comment in workspace-secret.ts, which already names this route by
    // name as covered. It never actually landed here: a client could still
    // download a live PDF of a signed SOW for a workspace the agency has
    // deleted. Checked before JWT verify, same order the GET route uses.
    if (await isWorkspaceDeleted(service, sow.workspace_id))
      return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

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

    const respond = (buf: Buffer, label: string) => new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${label}"`,
        'Content-Length':      String(buf.length),
        'Cache-Control':       'private, no-cache',
      },
    })
    const baseName = `SOW-${(sow.projects?.name || 'document').replace(/[^a-z0-9]/gi, '-')}-v${sow.version}`

    // Executed copy, rendered once at signing (see sign route / lib/documents/executed-pdf.ts).
    if (isSigned) {
      const frozen = await fetchExecutedPdf(service, sow.pdf_path)
      if (frozen) return respond(frozen, `${baseName}.pdf`)
      // Signed before executed copies were stored: fall through to a live render (below).
    }

    const project = sow.projects
    const client  = project?.clients
    const ws      = project?.workspaces

    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    // Only the schedule that existed when the SOW was signed. Rows the retainer cron adds every
    // month (and anything else attached later) are billing state, not part of the agreement, and
    // used to pile up inside the "signed" PDF.
    let milestones: any[] | null = []
    if (isSigned) {
      const cutoff = new Date(new Date(sow.signed_at).getTime() + 10 * 60 * 1000).toISOString()
      const res = await (service as any)
        .from('payment_milestones')
        .select('title, amount, percentage, trigger, due_date, status')
        .eq('sow_id', sow.id)
        .lte('created_at', cutoff)
        .order('due_date', { ascending: true, nullsFirst: false })
      milestones = res.data
    }

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
      signedBy:      isSigned ? (sow.signed_by || undefined) : undefined,
      signedAt:      isSigned ? (sow.signed_at || undefined) : undefined,
      agencySignatureData: ws?.agency_signature_data || null,
      clientSignatureData: isSigned ? (sow.client_signature_data || null) : null,
      version:       sow.version,
      isWatermarked: !isSigned,
      documentNumber: sow.document_number || null,
    })

    return respond(pdfBuffer, isSigned ? `${baseName}.pdf` : `${baseName}-for-review.pdf`)
  } catch (err) {
    console.error('Portal SOW PDF error:', err)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
