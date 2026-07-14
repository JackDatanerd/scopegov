export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { sendCoAcceptedEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }      = await params
    const { signerName } = await request.json()

    if (!signerName || signerName.trim().length < 3)
      return NextResponse.json({ error: 'Full name required' }, { status: 400 })

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
    if (!['awaiting_response','countered'].includes(co.status))
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

    // BUG-047: acceptedAt unconditionally populated on ALL acceptance paths
    await (service as any).from('change_orders').update({
      status:       'accepted',
      accepted_at:  now,   // unconditional — always set
      accepted_by:  signerName.trim(),
      responded_at: now,
      updated_at:   now,
    }).eq('id', co.id)

    // Revoke token — superseded
    await (service as any).from('revoked_tokens').insert({
      token, token_type: 'co', reason: 'superseded',
    }).catch(() => {})

    // BUG-052: amendment signedSowId = highest-versioned signed SOW
    const { data: signedSow } = await (service as any)
      .from('sow_documents')
      .select('id')
      .eq('project_id', co.project_id)
      .eq('status', 'signed')
      .order('version', { ascending: false })
      .limit(1).single()

    if (!signedSow)
      return NextResponse.json({ error: 'No signed SOW found for this project' }, { status: 422 })

    // Create ONE amendment (spec §0.11)
    const lineItems  = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])
    const deliverables = lineItems.map((l: any) => l.description).filter(Boolean)

    await (service as any).from('amendments').insert({
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
      const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_accepted')
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

    return NextResponse.json({
      ok: true,
      message: `Thank you, ${signerName.trim()}. The change order has been accepted. ${project.workspaces.agency_name} has been notified.`,
    })
  } catch (err) {
    console.error('CO accept error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
