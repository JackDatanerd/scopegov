export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { sendCoAcceptedEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }      = await params
    const { signerName, signatureData } = await request.json()

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
      .select(`id,title,status,version,line_items,subtotal,tax_rate,tax_inclusive,total,flag_id,
        project_id,workspace_id,
        projects(id,name,currency,clients(name,email,cc_emails),
          workspaces(id,agency_name,brand_colour,jwt_secret))`)
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
    // from; once they've countered, the ball is in the agency's court —
    // they resolve it via accept-counter, decline, or withdraw.
    if (co.status !== 'awaiting_response')
      return NextResponse.json({ error: 'CO cannot be accepted in current status' }, { status: 409 })

    try {
      const secret = new TextEncoder().encode(co.projects.workspaces.jwt_secret)
      await jwtVerify(token, secret)
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })
    }

    const now     = new Date().toISOString()
    const project = co.projects
    const client  = project.clients

    // FIX: this signed-SOW lookup used to happen AFTER marking the CO
    // 'accepted' — if it failed, the client got a confusing 422 error after
    // already being told they'd accepted, while the CO's status had already
    // changed in the DB regardless (amendment never created, financial
    // impact never applied). Check first, fail fast, before any write.
    const { data: signedSow } = await (service as any)
      .from('sow_documents')
      .select('id')
      .eq('project_id', co.project_id)
      .eq('status', 'signed')
      .order('version', { ascending: false })
      .limit(1).single()

    if (!signedSow)
      return NextResponse.json({ error: 'No signed SOW found for this project — cannot record this amendment' }, { status: 422 })

    // BUG-047: acceptedAt unconditionally populated on ALL acceptance paths
    await (service as any).from('change_orders').update({
      status:       'accepted',
      accepted_at:  now,   // unconditional — always set
      accepted_by:  signerName.trim(),
      client_signature_data: signatureData,
      responded_at: now,
      updated_at:   now,
    }).eq('id', co.id)

    // Revoke token — superseded
    try {
      await (service as any).from('revoked_tokens').insert({
        token, token_type: 'co', reason: 'superseded',
      })
    } catch (e) { console.error('Token revoke insert failed (non-fatal):', e) }

    // Create ONE amendment (spec §0.11)
    const lineItems  = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])
    const deliverables = lineItems.map((l: any) => l.description).filter(Boolean)

    // FIX: this insert's error was never checked — a silent failure here
    // (constraint violation, bad data, etc.) meant the CO showed as
    // accepted with no amendment ever created and no financial impact
    // applied, with zero visibility into why. Now logged if it happens.
    const { error: amendErr } = await (service as any).from('amendments').insert({
      project_id:          co.project_id,
      workspace_id:        co.workspace_id,
      change_order_id:     co.id,
      signed_sow_id:       signedSow.id,  // handler rule (spec §0.11)
      title:               `Amendment — ${co.title}`,
      added_deliverables:  deliverables,
      removed_deliverables: [],
      financial_impact:    co.total,
      effective_at:        now,
      pdf_path:            '',            // PDF generated async
    })
    if (amendErr) console.error('Amendment insert failed after CO accept:', amendErr, { coId: co.id })

    // Update scope snapshot
    try {
      const { data: snap } = await (service as any)
        .from('project_scope_snapshot').select('id,deliverables').eq('project_id', co.project_id).single()
      if (snap) {
        const existing    = snap.deliverables || []
        const newItems    = deliverables.map((d: string) => ({ title: d }))
        await (service as any).from('project_scope_snapshot').update({
          deliverables:    [...existing, ...newItems],
          last_updated_at: now,
          last_updated_by: 'amendment',
        }).eq('project_id', co.project_id)
      }
    } catch (e) { console.error('Snapshot update failed:', e) }

    // Resolve linked flag if any
    if (co.flag_id) {
      await (service as any).from('guardian_flags').update({
        status: 'resolved', resolution: 'change_order',
        resolved_at: now, updated_at: now,
      }).eq('id', co.flag_id)
    }

    await logAudit(service, {
      workspaceId: co.workspace_id, actorId: client.email,
      actorEmail: client.email, actorName: signerName.trim(),
      eventType: 'co.accepted', entityType: 'change_order',
      entityId: co.id, entityName: co.title,
      metadata: { total: co.total, signer: signerName.trim(), flag_resolved: !!co.flag_id },
    })

    // Notify agency (Event 11) — awaited
    try {
      const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_accepted', co.project_id)
      if (emails.length) {
        await sendCoAcceptedEmail({
          to: emails, agencyName: project.workspaces.agency_name,
          clientName: client.name, projectName: project.name,
          coTitle: co.title, total: co.total, currency: project.currency || 'USD',
          acceptedBy: signerName.trim(),
          projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
        })
      }
    } catch (e) { console.error('CO accepted email failed:', e) }
    await notifyMembersWithPermission(service, {
      workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_accepted',
      type: 'co_accepted', title: `CO accepted — ${co.title}`,
      body: `${signerName.trim()} accepted ${project.currency || 'USD'} ${co.total} for ${project.name}.`,
      entityType: 'project', entityId: co.project_id, projectId: co.project_id,
    })

    return NextResponse.json({
      ok: true,
      message: `Thank you, ${signerName.trim()}. The change order has been accepted. ${project.workspaces.agency_name} has been notified.`,
    })
  } catch (err) {
    console.error('CO accept error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
