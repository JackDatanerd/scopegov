export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'
import { sendSowDeclinedEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { checkRevokedToken, verifySowJwt } from '../_shared'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }  = await params
    const service    = createServiceClient()
    // FEATURE (portal audit, section 18): see migration 030.
    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'sow.decline')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'sow.decline')

    const { reason } = await request.json().catch(() => ({ reason: null }))

    const { revoked } = await checkRevokedToken(service, token)
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id,version,status,project_id,workspace_id,projects(id,name,workspaces(agency_name),clients(name,email))')
      .eq('token', token).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'SOW cannot be declined in current status' }, { status: 409 })

    // jwt_secret lives in workspace_secrets now, not on workspaces itself —
    // see migration 013.
    if (!(await verifySowJwt(service, token, sow.workspace_id)))
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })

    const now     = new Date().toISOString()
    const project = sow.projects
    const client  = project.clients

    // Decline SOW
    // FIX (re-audit, race-condition finding): same class of gap already
    // fixed on the sign route (see that file's writeup) — this used to
    // write unconditionally on `.eq('id', sow.id)`, so a Decline racing a
    // near-simultaneous Sign could stomp an already-signed SOW back to
    // 'declined' after the fact. CAS on the still-'awaiting_signature'
    // status closes the window.
    const { data: updated, error: updateErr } = await (service as any)
      .from('sow_documents')
      .update({
        status: 'declined', declined_at: now, declined_reason: reason || null, updated_at: now,
      })
      .eq('id', sow.id)
      .eq('status', 'awaiting_signature')
      .select('id')

    if (updateErr) return NextResponse.json({ error: 'Failed to decline' }, { status: 500 })
    if (!updated || updated.length === 0)
      return NextResponse.json({ error: 'This SOW was already responded to' }, { status: 409 })

    // Revoke token — reason: 'declined' (spec §4.3)
    await (service as any).from('revoked_tokens').insert({
      token, token_type: 'sow', reason: 'declined',
    })

    // FIX (re-audit, cron/portal section): if sow-stall's cron already
    // flipped this project to status='Stalled'/stall_reason='sow_unsigned'
    // before the client got around to responding, "stays at Awaiting
    // Signature" (the comment below) was only true in the case where the
    // cron hadn't fired yet. When it had, the project was left stuck
    // showing "SOW unsigned — project stalled" forever instead of "Client
    // declined SOW" — attentionReason() checks status==='Stalled' before
    // ever looking at the SOW's actual status (see lib/utils/attention.ts).
    // Only undo the auto-stall specifically caused by *this* SOW
    // (stall_reason==='sow_unsigned') — a project stalled manually for an
    // unrelated reason should stay stalled regardless of what happens here.
    await (service as any).from('projects').update({
      status: 'Awaiting Signature', stall_reason: null, updated_at: now,
    }).eq('id', project.id).eq('status', 'Stalled').eq('stall_reason', 'sow_unsigned')

    // Project stays at Awaiting Signature — surfaces on attention list (spec §4.3)

    await logAudit(service, {
      workspaceId: sow.workspace_id, actorId: client.email,
      actorEmail: client.email, actorName: client.name,
      eventType: 'sow.declined', entityType: 'sow',
      entityId: sow.id, entityName: project.name,
      metadata: { version: sow.version, reason },
    })

    // Notify agency (Event 5) — awaited
    try {
      const emails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_declined', project.id)
      if (emails.length) {
        await sendSowDeclinedEmail({
          to: emails, agencyName: project.workspaces.agency_name,
          clientName: client.name, projectName: project.name, reason,
        })
      }
    } catch (e) { console.error('SOW declined email failed:', e) }
    await notifyMembersWithPermission(service, {
      workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_declined',
      type: 'sow_declined', title: `SOW declined — ${project.name}`,
      body: reason ? `${client.name} declined: ${reason}` : `${client.name} declined the Statement of Work.`,
      entityType: 'project', entityId: project.id, projectId: project.id,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
