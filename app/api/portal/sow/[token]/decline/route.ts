export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'
import { sendSowDeclinedEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { checkRevokedToken, verifySowJwt } from '../_shared'
import { isWorkspaceDeleted } from '@/lib/utils/workspace-secret'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'
import { cleanTextField } from '@/lib/utils/sanitize'
import { checkedSend } from '@/lib/email/delivery'
import { sendClientResponseReceivedEmail } from '@/lib/email/templates'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }  = await params
    const service    = createServiceClient()
    // FEATURE (portal audit, section 18): see migration 030.
    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'sow.decline')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'sow.decline')

    const reqBody = await request.json().catch(() => ({} as any))
    // Free text from an unauthenticated visitor: type-checked, stripped of markup and capped (it
    // used to be stored, audited and pushed into notifications verbatim, at any length).
    const cleanedReason = cleanTextField(reqBody?.reason, 2000)
    if (cleanedReason === null)
      return NextResponse.json({ error: 'reason must be text' }, { status: 400 })
    const reason = cleanedReason || undefined

    const { revoked } = await checkRevokedToken(service, token)
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id,version,status,project_id,workspace_id,projects(id,name,client_id,workspaces(agency_name,brand_colour),clients(name,email,cc_emails))')
      .eq('token', token).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'SOW cannot be declined in current status' }, { status: 409 })

    // jwt_secret lives in workspace_secrets now, not on workspaces itself —
    // see migration 013.
    if (!(await verifySowJwt(service, token, sow.workspace_id)))
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — flagship
    // finding): see isWorkspaceDeleted's own comment in workspace-secret.ts.
    if (await isWorkspaceDeleted(service, sow.workspace_id))
      return NextResponse.json({ error: 'This link is no longer active' }, { status: 410 })

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
        // FIX (section-9 re-pass): withdraw() already nulls the token
        // here for the same reason — the revoked_tokens insert below is
        // what actually enforces the block, but leaving the raw JWT
        // sitting on a dead row is needless exposure. decline() never
        // matched that hygiene.
        token: null,
      })
      .eq('id', sow.id)
      .eq('status', 'awaiting_signature')
      .select('id')

    if (updateErr) return NextResponse.json({ error: 'Failed to decline' }, { status: 500 })
    if (!updated || updated.length === 0)
      return NextResponse.json({ error: 'This SOW was already responded to' }, { status: 409 })

    // Revoke token — reason: 'declined' (spec §4.3)
    const { error: revokeErr } = await (service as any).from('revoked_tokens').insert({
      token, token_type: 'sow', reason: 'declined', document_id: sow.id,
    })
    if (revokeErr) console.error('SOW decline: token revoke insert failed (non-fatal):', revokeErr.message)

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
      // FIX (build, Reports & Audit re-pass): actor_id is `uuid REFERENCES
      // users(id)` — client.email is not a valid uuid, so this insert
      // failed silently (unchecked supabase-js error) and 'sow.declined'
      // never reached audit_log. null is correct for a non-platform-user
      // actor; actorEmail/actorName already carry the real identity.
      workspaceId: sow.workspace_id, actorId: null,
      actorEmail: client.email, actorName: client.name,
      eventType: 'sow.declined', entityType: 'sow',
      entityId: sow.id, entityName: project.name,
      metadata: { version: sow.version, ...(reason ? { reason } : {}) },
    })

    // Notify agency (Event 5) — awaited
    const emails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_declined', project.id).catch(() => [] as string[])
    if (emails.length) {
      await checkedSend(() => sendSowDeclinedEmail({
        to: emails, agencyName: project.workspaces.agency_name,
        clientName: client.name, projectName: project.name, reason, projectId: project.id,
      }), 'SOW declined (agency) email')
    }
    // Confirm receipt to the client — they previously got nothing back after declining.
    if (client.email) {
      const cc = await withPrimaryContactCc(service, project.client_id, client.email, client.cc_emails)
      await checkedSend(() => sendClientResponseReceivedEmail({
        to: client.email, cc, clientName: client.name, agencyName: project.workspaces.agency_name,
        projectName: project.name, documentLabel: 'Statement of Work', response: 'declined',
        note: reason ? reason.slice(0, 500) : null, brandColour: project.workspaces.brand_colour,
      }), 'SOW declined (client receipt)')
    }
    await notifyMembersWithPermission(service, {
      workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_declined',
      type: 'sow_declined', title: `SOW declined — ${project.name}`,
      body: reason ? `${client.name} declined: ${reason.slice(0, 200)}` : `${client.name} declined the Statement of Work.`,
      entityType: 'project', entityId: project.id, projectId: project.id,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('SOW decline error:', err)
    return NextResponse.json({ error: 'Could not record your response. Please try again.' }, { status: 500 })
  }
}
