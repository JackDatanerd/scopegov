export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { getWorkspaceJwtSecret, isWorkspaceDeleted } from '@/lib/utils/workspace-secret'
import { finalizeCoAcceptance } from '@/lib/documents/finalize-co'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'
import { cleanTextField } from '@/lib/utils/sanitize'
import { isValidSignatureImage } from '@/lib/utils/signature'

// FIX (doc-completeness audit, migration 014): new endpoint — the client's
// signing step for a CO that reached 'awaiting_countersignature' after the
// agency accepted their counter-offer. Deliberately mirrors the
// validation in the direct-accept route so both paths require the same
// evidence (typed name + drawn signature) before a CO can become final.
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()
    // FEATURE (portal audit, section 18): see migration 030.
    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'co.countersign')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'co.countersign')

    const reqBody = await request.json().catch(() => null)
    if (!reqBody || typeof reqBody !== 'object')
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const signerName = cleanTextField((reqBody as any).signerName, 120)
    const signatureData = (reqBody as any).signatureData
    const ip = clientIp || 'unknown'

    if (!signerName || signerName.length < 3)
      return NextResponse.json({ error: 'Full name required' }, { status: 400 })
    if (!isValidSignatureImage(signatureData))
      return NextResponse.json({ error: 'Please draw your signature to confirm' }, { status: 400 })

    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('id').eq('token', token).single()
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id,title,note,status,version,line_items,subtotal,tax_rate,tax_inclusive,total,flag_id,
        timeline_impact_days,scope_impact_note,is_retainer_renewal,renewal_term_months,
        token,document_number,project_id,workspace_id,
        projects(id,name,type,currency,contract_value,client_id,clients(name,email,cc_emails,company_name,billing_address,vat_number),
          workspaces(id,agency_name,brand_colour,logo_storage_path,agency_signature_data,
            legal_address,tax_id,phone,website))`)
      .eq('token', token).single()

    if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    if (co.status !== 'awaiting_countersignature')
      return NextResponse.json({ error: 'CO is not awaiting countersignature' }, { status: 409 })

    try {
      const jwtSecret = await getWorkspaceJwtSecret(service, co.workspace_id)
      if (!jwtSecret) throw new Error('no secret')
      const secret = new TextEncoder().encode(jwtSecret)
      await jwtVerify(token, secret)
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })
    }

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — flagship
    // finding): see isWorkspaceDeleted's own comment in workspace-secret.ts.
    if (await isWorkspaceDeleted(service, co.workspace_id))
      return NextResponse.json({ error: 'This link is no longer active' }, { status: 410 })

    const result = await finalizeCoAcceptance(service, {
      co, signerName, signatureData, source: 'countersignature', signerIp: ip,
      // FIX (re-audit, race-condition finding): see finalize-co.ts —
      // this is the compare-and-swap guard, not just a pre-check.
      expectedStatus: 'awaiting_countersignature',
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    // FIX (portal audit, section 18): document_id added so a client who
    // revisits the ORIGINAL (pre-countersignature) email link can still be
    // routed to their now-confirmed CO — see migration 029.
    const { error: supersedeErr } = await (service as any).from('revoked_tokens').insert({
      token, token_type: 'co', reason: 'superseded', document_id: co.id,
    })
    if (supersedeErr) console.error('CO countersign: token supersede insert failed (non-fatal):', supersedeErr.message)

    return NextResponse.json({
      ok: true,
      message: `Thank you, ${signerName}. The change order is confirmed. ${result.agencyName} has been notified.`,
      token: result.token,
    })
  } catch (err) {
    console.error('CO countersign error:', err)
    return NextResponse.json({ error: 'Could not record your confirmation. Please try again.' }, { status: 500 })
  }
}
