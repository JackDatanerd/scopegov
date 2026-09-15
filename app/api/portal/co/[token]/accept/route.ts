export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { finalizeCoAcceptance } from '@/lib/documents/finalize-co'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }      = await params
    const { signerName, signatureData } = await request.json()
    // FIX (doc-completeness audit, finding #2): same capture pattern as
    // app/api/portal/sow/[token]/sign/route.ts — see migration 015.
    const ip              = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'

    if (!signerName || signerName.trim().length < 3)
      return NextResponse.json({ error: 'Full name required' }, { status: 400 })
    if (!signatureData || typeof signatureData !== 'string' || !signatureData.startsWith('data:image/'))
      return NextResponse.json({ error: 'Please draw your signature to accept' }, { status: 400 })
    // FIX (audit round 3): no upper bound existed on this field at all — a
    // signature pad's data URL is normally a few KB, but nothing stopped an
    // arbitrarily large base64 payload from being submitted and stored
    // (storage bloat, and this value gets re-embedded into every future
    // PDF render of this CO). 500 KB is generously above what a real
    // signature drawing produces.
    if (signatureData.length > 500_000)
      return NextResponse.json({ error: 'Signature data is too large' }, { status: 400 })

    const service = createServiceClient()

    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('id').eq('token', token).single()
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id,title,note,status,version,line_items,subtotal,tax_rate,tax_inclusive,total,flag_id,
        timeline_impact_days,scope_impact_note,
        token,document_number,project_id,workspace_id,
        projects(id,name,currency,clients(name,email,cc_emails,company_name,billing_address,vat_number),
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
    if (co.status !== 'awaiting_response')
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

    const project = co.projects
    const client  = project.clients

    const result = await finalizeCoAcceptance(service, {
      co, signerName: signerName.trim(), signatureData, source: 'direct', signerIp: ip,
      // FIX (re-audit, race-condition finding): see finalize-co.ts —
      // this is the compare-and-swap guard, not just a pre-check.
      expectedStatus: 'awaiting_response',
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    // Revoke token — superseded
    try {
      await (service as any).from('revoked_tokens').insert({
        token, token_type: 'co', reason: 'superseded',
      })
    } catch (e) { console.error('Token revoke insert failed (non-fatal):', e) }

    return NextResponse.json({
      ok: true,
      message: `Thank you, ${signerName.trim()}. The change order has been accepted. ${result.agencyName} has been notified.`,
      token: result.token,
    })
  } catch (err) {
    console.error('CO accept error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
