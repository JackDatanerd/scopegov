export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { escapeHtml } from '@/lib/utils/sanitize'
import { checkRevokedToken, verifySowJwt } from '../_shared'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const { note }  = await request.json()

    if (!note || note.trim().length < 20)
      return NextResponse.json({ error: 'Please describe the changes needed (minimum 20 characters)' }, { status: 400 })

    const service = createServiceClient()

    const { revoked } = await checkRevokedToken(service, token)
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id,version,status,sections,metadata,project_id,workspace_id,projects(id,name,disc,workspaces(agency_name),clients(name,email))')
      .eq('token', token).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'SOW is not awaiting signature' }, { status: 409 })

    // jwt_secret lives in workspace_secrets now, not on workspaces itself —
    // see migration 013.
    if (!(await verifySowJwt(service, token, sow.workspace_id)))
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })

    const now     = new Date().toISOString()
    const project = sow.projects
    const client  = project.clients

    // Mark current version as changes_requested
    // FIX (re-audit, race-condition finding): same class of gap already
    // fixed on the sign route — this used to write unconditionally on
    // `.eq('id', sow.id)`, so a Request Changes racing a near-simultaneous
    // Sign could flip an already-signed SOW to 'changes_requested' (and
    // spin up a redundant new draft version) after the fact. CAS on the
    // still-'awaiting_signature' status closes the window.
    const { data: updated, error: updateErr } = await (service as any)
      .from('sow_documents')
      .update({ status: 'changes_requested', updated_at: now })
      .eq('id', sow.id)
      .eq('status', 'awaiting_signature')
      .select('id')

    if (updateErr) return NextResponse.json({ error: 'Failed to request changes' }, { status: 500 })
    if (!updated || updated.length === 0)
      return NextResponse.json({ error: 'This SOW was already responded to' }, { status: 409 })

    // Create new draft version (same transaction per spec §1.3)
    const { data: newSow } = await (service as any).from('sow_documents').insert({
      project_id:          project.id,
      workspace_id:        sow.workspace_id,
      version:             sow.version + 1,
      status:              'draft',
      sections:            sow.sections,
      metadata:            sow.metadata,
      previous_version_id: sow.id,
    }).select('id').single()

    // Update project status to Changes Requested
    // FIX (re-audit, portal section): also clears stall_reason, same
    // data-hygiene fix as the sign route — harmless today since nothing
    // reads stall_reason off a non-Stalled project, but stale otherwise.
    await (service as any).from('projects').update({
      status: 'Changes Requested', stall_reason: null, updated_at: now,
    }).eq('id', project.id)

    await logAudit(service, {
      workspaceId: sow.workspace_id, actorId: client.email,
      actorEmail: client.email, actorName: client.name,
      eventType: 'sow.changes_requested', entityType: 'sow',
      entityId: sow.id, entityName: project.name,
      metadata: { note, new_version: sow.version + 1, new_sow_id: newSow?.id },
    })

    // Notify agency members with SEND_SOW permission (Event 6)
    try {
      const emails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, undefined, project.id)
      if (emails.length) {
        const { Resend } = await import('resend')
        const resend = new Resend(process.env.RESEND_API_KEY)
        // FIX (audit round 4, finding #7): client.name, project.name, and
        // note are all interpolated raw into an inline HTML email here —
        // note especially is typed directly into an unauthenticated
        // portal form by whoever holds the signing link, making this a
        // directly attacker-reachable injection point into an email your
        // own team reads and trusts. See lib/utils/sanitize.ts's
        // escapeHtml (same helper already used for this exact purpose in
        // app/api/portal/co/[token]/_actions.ts).
        await resend.emails.send({
          from: `${escapeHtml(project.workspaces.agency_name)} via ScopeGov <${process.env.RESEND_FROM_EMAIL}>`,
          to: emails,
          subject: `${client.name} requested changes on the ${project.name} SOW`,
          html: `<p><strong>${escapeHtml(client.name)}</strong> has requested changes on the <strong>${escapeHtml(project.name)}</strong> SOW (v${sow.version}).</p>
          <p><strong>Feedback:</strong> ${escapeHtml(note)}</p>
          <p>A new draft (v${sow.version + 1}) has been created in ScopeGov for you to edit and resend.</p>
          <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=sow">Open project in ScopeGov →</a></p>`,
        })
      }
    } catch (e) { console.error('Changes requested email failed:', e) }
    await notifyMembersWithPermission(service, {
      workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_changes_requested',
      type: 'sow_changes_requested', title: `Changes requested — ${project.name}`,
      body: `${client.name}: ${note}`.slice(0, 160),
      entityType: 'project', entityId: project.id, projectId: project.id,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
