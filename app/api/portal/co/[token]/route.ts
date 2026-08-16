export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { sendCoAcceptedEmail } from '@/lib/email/templates'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

async function getCoByToken(token: string, service: any) {
  const { data: revoked } = await (service as any)
    .from('revoked_tokens').select('reason').eq('token', token).single()
  if (revoked) return { state: revoked.reason === 'declined' ? 'declined' : 'revoked' }

  // FIX (doc-completeness audit): same gap as the SOW portal route — legal
  // and billing fields were never selected here, so the client accepted a
  // CO without ever seeing the agency/client addresses or tax IDs that
  // appear on the CO PDF.
  const { data: co } = await (service as any)
    .from('change_orders')
    .select(`id,title,note,status,version,line_items,subtotal,tax_rate,tax_inclusive,
      total,expires_at,flag_id,workspace_id,accepted_by,accepted_at,client_signature_data,
      projects(id,name,currency,clients(name,email,cc_emails,company_name,billing_address,vat_number),
        workspaces(id,agency_name,brand_colour,logo_storage_path,agency_signature_data,
          legal_address,tax_id,phone,website))`)
    .eq('token', token).single()

  if (!co) return { state: 'invalid' }

  // jwt_secret lives in workspace_secrets now, not on workspaces itself —
  // see migration 013.
  try {
    const jwtSecret = await getWorkspaceJwtSecret(service, co.workspace_id)
    if (!jwtSecret) throw new Error('no secret')
    const secret = new TextEncoder().encode(jwtSecret)
    await jwtVerify(token, secret)
  } catch {
    if (co.expires_at && new Date(co.expires_at) < new Date()) return { state: 'expired' }
    return { state: 'invalid' }
  }

  // BUG: 'closed', 'stalled', and 'countered' were never included here, so
  // revisiting the link for a CO in any of those states fell through to the
  // default case below and re-served the full accept/decline/counter form.
  if (co.status === 'accepted') {
    return { state: 'accepted', acceptedBy: co.accepted_by, clientSignatureData: co.client_signature_data || null }
  }
  if (['declined','withdrawn','closed','stalled','countered'].includes(co.status)) return { state: co.status }

  // FIX (doc-completeness audit, migration 014): a CO the agency has
  // accepted at the client's counter amount now needs the client to
  // countersign before it's final — distinct from the original
  // accept/counter/decline form, which no longer applies here.
  return { co, mode: co.status === 'awaiting_countersignature' ? 'countersign' : 'respond' }
}

// GET — return CO data for portal
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service   = createServiceClient()
    const result    = await getCoByToken(token, service)

    if (result.state) return NextResponse.json({
      state: result.state,
      acceptedBy: (result as any).acceptedBy,
      clientSignatureData: (result as any).clientSignatureData,
    })

    const co  = result.co!
    const mode = (result as any).mode || 'respond'
    const ws  = co.projects?.workspaces
    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const lineItems = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])

    return NextResponse.json({
      co: {
        id:          co.id,
        title:       co.title,
        note:        co.note,
        mode,
        projectName: co.projects?.name,
        agencyName:  ws?.agency_name,
        brandColour: ws?.brand_colour || '#1A5C3A',
        logoUrl,
        agencyAddress: ws?.legal_address || null,
        agencyTaxId:   ws?.tax_id || null,
        agencyPhone:   ws?.phone || null,
        agencyWebsite: ws?.website || null,
        agencySignatureData: ws?.agency_signature_data || null,
        lineItems,
        subtotal:    co.subtotal,
        taxRate:     co.tax_rate,
        taxInclusive: co.tax_inclusive,
        total:       co.total,
        currency:    co.projects?.currency || 'USD',
        clientName:  co.projects?.clients?.name || '',
        clientCompany: co.projects?.clients?.company_name || null,
        clientBillingAddress: co.projects?.clients?.billing_address || null,
        clientVatNumber:      co.projects?.clients?.vat_number || null,
        version:     co.version,
        expiresAt:   co.expires_at,
      },
    })
  } catch (err) {
    return NextResponse.json({ state: 'invalid' })
  }
}
