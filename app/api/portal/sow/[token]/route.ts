export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service   = createServiceClient()

    // Check revoked tokens first
    const { data: revoked } = await (service as any)
      .from('revoked_tokens')
      .select('reason')
      .eq('token', token)
      .single()

    if (revoked) {
      return NextResponse.json({
        state: revoked.reason === 'declined' ? 'declined'
          : revoked.reason === 'withdrawn' ? 'withdrawn'
          : 'revoked',
      })
    }

    // Find SOW by token
    // FIX (doc-completeness audit): this query never selected legal/billing
    // fields (agency legal_address/tax_id/phone/website, client
    // billing_address/vat_number), so the page a client actually reviews
    // and signs on was missing details that only showed up later on the
    // PDF generated after signing. Select them so the pre-signature view
    // matches the document of record.
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, status, sections, metadata, expires_at, signed_at, signed_by, client_signature_data,
        projects(id, name, disc, contract_value, currency, client_id,
          clients(name, email, company_name, billing_address, vat_number),
          workspaces(id, agency_name, brand_colour, logo_storage_path, agency_signature_data,
            legal_address, tax_id, phone, website))`)
      .eq('token', token)
      .single()

    if (!sow) return NextResponse.json({ state: 'invalid' })

    // Verify JWT with workspace-specific secret — jwt_secret lives in
    // workspace_secrets now, not on workspaces itself — see migration 013.
    const workspace = sow.projects?.workspaces
    try {
      const jwtSecret = workspace?.id ? await getWorkspaceJwtSecret(service, workspace.id) : null
      if (!jwtSecret) throw new Error('no secret')
      const secret = new TextEncoder().encode(jwtSecret)
      await jwtVerify(token, secret)
    } catch {
      // Token expired or invalid signature
      if (sow.expires_at && new Date(sow.expires_at) < new Date()) {
        return NextResponse.json({ state: 'expired' })
      }
      return NextResponse.json({ state: 'invalid' })
    }

    if (sow.status === 'signed') {
      return NextResponse.json({
        state: 'signed',
        signedBy: sow.signed_by, signedAt: sow.signed_at,
        clientSignatureData: sow.client_signature_data || null,
      })
    }
    if (sow.status === 'withdrawn')  return NextResponse.json({ state: 'withdrawn' })
    if (sow.status === 'declined')   return NextResponse.json({ state: 'declined' })
    if (sow.status === 'expired')    return NextResponse.json({ state: 'expired' })
    // BUG: changes_requested was never checked here, so revisiting a link
    // after requesting changes fell through to the default case below and
    // re-served the full signing form as if nothing had happened.
    if (sow.status === 'changes_requested') return NextResponse.json({ state: 'changes_requested' })

    // Build logo URL if exists
    let logoUrl: string | null = null
    if (workspace.logo_storage_path) {
      const { data: urlData } = await (service as any).storage
        .from('logos')
        .getPublicUrl(workspace.logo_storage_path)
      logoUrl = urlData?.publicUrl || null
    }

    const project = sow.projects
    const client  = project?.clients

    // FIX (doc-completeness audit): payment schedule was never fetched
    // for this page either — the client reviewed and signed the SOW
    // without ever seeing the milestone/payment schedule that the PDF
    // (generated only after signing) already showed.
    const { data: milestones } = await (service as any)
      .from('payment_milestones')
      .select('title, amount, percentage, trigger, due_date, status')
      .eq('sow_id', sow.id)
      .order('due_date', { ascending: true, nullsFirst: false })

    return NextResponse.json({
      sow: {
        id:            sow.id,
        projectName:   project.name + (project.disc ? ` — ${project.disc}` : ''),
        agencyName:    workspace.agency_name,
        brandColour:   workspace.brand_colour || '#1A5C3A',
        logoUrl,
        agencyAddress: workspace.legal_address || null,
        agencyTaxId:   workspace.tax_id || null,
        agencyPhone:   workspace.phone || null,
        agencyWebsite: workspace.website || null,
        agencySignatureData: workspace.agency_signature_data || null,
        contractValue: project.contract_value || 0,
        currency:      project.currency || 'USD',
        clientName:    client?.name || '',
        clientEmail:   client?.email || '',
        clientCompany: client?.company_name || null,
        clientBillingAddress: client?.billing_address || null,
        clientVatNumber:      client?.vat_number || null,
        sections:      sow.sections || [],
        paymentSchedule: (milestones || []).map((m: any) => ({
          title: m.title, amount: m.amount, percentage: m.percentage,
          trigger: m.trigger, dueDate: m.due_date, status: m.status,
        })),
        version:       sow.version,
        expiresAt:     sow.expires_at,
      },
    })
  } catch (err) {
    console.error('Portal SOW fetch error:', err)
    return NextResponse.json({ state: 'invalid' })
  }
}
