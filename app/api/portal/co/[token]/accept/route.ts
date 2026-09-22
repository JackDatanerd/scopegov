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
import { CLIENT_RESPONDABLE_STATUSES } from '../_actions'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }      = await params
    const service        = createServiceClient()
    // FEATURE (portal audit, section 18): see migration 030.
    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'co.accept')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'co.accept')

    const reqBody = await request.json().catch(() => null)
    if (!reqBody || typeof reqBody !== 'object')
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const signerName = cleanTextField((reqBody as any).signerName, 120)
    const signatureData = (reqBody as any).signatureData
    // The real client hop, not the raw x-forwarded-for chain.
    const ip = clientIp || 'unknown'

    if (!signerName || signerName.length < 3)
      return NextResponse.json({ error: 'Full name required' }, { status: 400 })
    // Real PNG/JPEG only — an SVG or corrupt image would make every later render of this executed
    // change order throw (see lib/utils/signature.ts).
    if (!isValidSignatureImage(signatureData))
      return NextResponse.json({ error: 'Please draw your signature to accept' }, { status: 400 })

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
    // FIX (audit round 5): once a client counters, this route used to
    // still accept the CO directly at the ORIGINAL co.total — the portal
    // UI hides the Accept button once status is 'countered' (see the GET
    // route), but that's UI-only, and the token stays valid. A client
    // could POST here directly and force-accept at the pre-counter price,
    // bypassing the accept-counter flow that's supposed to be the only
    // way to close out a countered CO (that route correctly uses
    // counter_amount, and is agency-side, gated by SEND_CHANGE_ORDERS).
    // Only 'awaiting_response' is a valid state for the CLIENT to accept
    // from directly; once they've countered, the ball is in the agency's
    // court — they resolve it via accept-counter (which now routes the
    // client back here — see migration 014 — through the
    // 'awaiting_countersignature' status), decline, or withdraw.
    if (!CLIENT_RESPONDABLE_STATUSES.includes(co.status))
      return NextResponse.json({ error: 'CO cannot be accepted in current status' }, { status: 409 })

    // jwt_secret lives in workspace_secrets now, not on workspaces itself —
    // see migration 013.
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

    const project = co.projects
    const client  = project.clients

    const result = await finalizeCoAcceptance(service, {
      co, signerName: signerName.trim(), signatureData, source: 'direct', signerIp: ip,
      // FIX (re-audit, race-condition finding): see finalize-co.ts —
      // this is the compare-and-swap guard, not just a pre-check.
      //
      // FIX (portal audit, section 18 re-pass): this was pinned to the
      // single string 'awaiting_response', but the pre-check just above
      // (CLIENT_RESPONDABLE_STATUSES) correctly lets a 'stalled' CO through
      // too — co-stall flips awaiting_response -> stalled after 5 days of no
      // reply. A client accepting a CO that had already stalled passed the
      // pre-check, then failed this CAS (the row is 'stalled', not
      // 'awaiting_response', so the update matched zero rows) and got a
      // false "This change order was already accepted" — nobody had
      // responded to it at all. CAS must accept the same set the pre-check
      // does.
      expectedStatus: CLIENT_RESPONDABLE_STATUSES,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    // Revoke token — superseded
    // FIX (portal audit, section 18): document_id added so a client who
    // revisits the ORIGINAL (pre-acceptance) email link can still be
    // routed to their now-accepted CO — see migration 029.
    const { error: supersedeErr } = await (service as any).from('revoked_tokens').insert({
      token, token_type: 'co', reason: 'superseded', document_id: co.id,
    })
    if (supersedeErr) console.error('CO accept: token supersede insert failed (non-fatal):', supersedeErr.message)

    return NextResponse.json({
      ok: true,
      message: `Thank you, ${signerName}. The change order has been accepted. ${result.agencyName} has been notified.`,
      token: result.token,
    })
  } catch (err) {
    console.error('CO accept error:', err)
    return NextResponse.json({ error: 'Could not record your acceptance. Please try again.' }, { status: 500 })
  }
}
