export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { insertNextSowVersion } from '@/lib/documents/sow-version'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { escapeHtml, cleanTextField } from '@/lib/utils/sanitize'
import { checkedSend } from '@/lib/email/delivery'
import { sendEmail } from '@/lib/email/send'
import { formatFrom } from '@/lib/email/from'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { sendClientResponseReceivedEmail } from '@/lib/email/templates'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkRevokedToken, verifySowJwt } from '../_shared'
import { isWorkspaceDeleted } from '@/lib/utils/workspace-secret'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()
    // FEATURE (portal audit, section 18): see migration 030.
    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'sow.requestChanges')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'sow.requestChanges')

    const reqBody = await request.json().catch(() => ({} as any))
    // Type-checked and stripped of markup BEFORE the length rules, so a non-string body can't
    // crash `.trim()` and tag-padding can't satisfy the 20-character minimum.
    const note = cleanTextField(reqBody?.note, 4000)
    if (note === null || note.length < 20)
      return NextResponse.json({ error: 'Please describe the changes needed (minimum 20 characters)' }, { status: 400 })
    if (typeof reqBody?.note === 'string' && reqBody.note.trim().length > 4000)
      return NextResponse.json({ error: 'Please keep your feedback under 4000 characters' }, { status: 400 })

    const { revoked } = await checkRevokedToken(service, token)
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id,version,status,sections,metadata,project_id,workspace_id,projects(id,name,disc,client_id,workspaces(agency_name,brand_colour),clients(name,email,cc_emails))')
      .eq('token', token).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'SOW is not awaiting signature' }, { status: 409 })

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
    // FIX (re-audit): the insert's error was never checked. If it failed,
    // the flow used to proceed anyway — the old SOW is now locked
    // ('changes_requested' + sent_at already set, so PATCH /api/sow/[id]
    // refuses to edit it) with no new draft ever created, leaving the
    // agency with no way back into editing short of the generic
    // /api/sow/generate fallback. Roll the status change back and tell the
    // client to retry instead of silently stranding the project.
    // FIX (section-9 audit, 9-B12): version was computed as
    // `sow.version + 1` with no uniqueness backstop — see
    // lib/documents/sow-version.ts and migration 031.
    //
    // FIX (section-9 audit, 9-G8): the client's feedback only ever
    // reached an email, a notification body and the audit log. Whoever
    // opened the new draft to act on it had no record inside the document
    // of what was actually asked for. Carry it on the new version's
    // metadata so the editor can show it (see components/sow/SowEditor.tsx).
    const changeRequest = {
      note,
      fromVersion: sow.version,
      requestedBy: client.name || client.email,
      requestedAt: now,
    }
    // If the agency already has an open draft for this project, attach the request to THAT draft
    // instead of stacking a second one (only one draft per project is allowed — migration 061).
    let newSow: { id: string; version: number } | null = null
    const { data: openDraft } = await (service as any)
      .from('sow_documents').select('id, version, metadata')
      .eq('project_id', project.id).eq('status', 'draft')
      .order('version', { ascending: false }).limit(1).maybeSingle()
    if (openDraft) {
      const { error: attachErr } = await (service as any).from('sow_documents')
        .update({ metadata: { ...(openDraft.metadata || {}), changeRequest }, updated_at: now })
        .eq('id', openDraft.id).eq('status', 'draft')
      if (!attachErr) newSow = { id: openDraft.id, version: openDraft.version }
    } else {
      const created = await insertNextSowVersion(service, project.id, {
        workspace_id:        sow.workspace_id,
        status:              'draft',
        sections:            sow.sections,
        metadata:            { ...(sow.metadata || {}), changeRequest },
        previous_version_id: sow.id,
      })
      if (created.ok) newSow = { id: created.id!, version: created.version ?? sow.version + 1 }
      else console.error('request-changes: new draft version insert failed', created.error)
    }

    if (!newSow) {
      await (service as any).from('sow_documents')
        .update({ status: 'awaiting_signature', updated_at: new Date().toISOString() })
        .eq('id', sow.id).eq('status', 'changes_requested')
      return NextResponse.json({ error: 'Something went wrong submitting your changes — please try again.' }, { status: 500 })
    }

    // Update project status to Changes Requested
    // FIX (re-audit, portal section): also clears stall_reason, same
    // data-hygiene fix as the sign route — harmless today since nothing
    // reads stall_reason off a non-Stalled project, but stale otherwise.
    await (service as any).from('projects').update({
      status: 'Changes Requested', stall_reason: null, updated_at: now,
    }).eq('id', project.id).in('status', ['Awaiting Signature', 'Stalled', 'Changes Requested'])

    await logAudit(service, {
      // FIX (build, Reports & Audit re-pass): actor_id is `uuid REFERENCES
      // users(id)` — client.email is not a valid uuid, so this insert
      // failed silently (unchecked supabase-js error) and
      // 'sow.changes_requested' never reached audit_log. null is correct
      // for a non-platform-user actor; actorEmail/actorName already carry
      // the real identity.
      workspaceId: sow.workspace_id, actorId: null,
      actorEmail: client.email, actorName: client.name,
      eventType: 'sow.changes_requested', entityType: 'sow',
      entityId: sow.id, entityName: project.name,
      metadata: { note, new_version: newSow.version, new_sow_id: newSow.id },
    })

    // Notify agency members with SEND_SOW permission (Event 6)
    const emails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_changes_requested', project.id).catch(() => [] as string[])
    if (emails.length) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL
      await checkedSend(() => sendEmail({
        // Header values are plain text: formatFrom() builds a valid quoted display name (and applies the
        // RESEND_FROM_EMAIL fallback this inline string lacked); nothing here is HTML-escaped.
        from: formatFrom(project.workspaces.agency_name),
        to: emails,
        subject: `${client.name} requested changes on the ${project.name} SOW`.replace(/[\r\n]+/g, ' '),
        html: `<p><strong>${escapeHtml(client.name)}</strong> has requested changes on the <strong>${escapeHtml(project.name)}</strong> SOW (v${sow.version}).</p>
          <p><strong>Feedback:</strong> ${escapeHtml(note)}</p>
          <p>A new draft (v${newSow.version}) is ready in ScopeGov for you to edit and resend.</p>
          <p><a href="${appUrl}/projects/${project.id}?tab=sow">Open project in ScopeGov →</a></p>
          <p style="font-size:11px;color:#909090;margin-top:20px;"><a href="${appUrl}/settings?tab=notifications" style="color:#909090;">Manage notification preferences</a></p>`,
      }), 'SOW changes requested (agency) email')
    }
    // Confirm receipt to the client.
    if (client.email) {
      const cc = await withPrimaryContactCc(service, project.client_id, client.email, client.cc_emails)
      const replyTo = await resolveReplyTo(service, sow.workspace_id, null)
      await checkedSend(() => sendClientResponseReceivedEmail({
        replyTo,
        to: client.email, cc, clientName: client.name, agencyName: project.workspaces.agency_name,
        projectName: project.name, documentLabel: 'Statement of Work', response: 'requested changes to',
        note: note.slice(0, 500), brandColour: project.workspaces.brand_colour,
      }), 'SOW changes requested (client receipt)')
    }
    await notifyMembersWithPermission(service, {
      workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_changes_requested',
      type: 'sow_changes_requested', title: `Changes requested — ${project.name}`,
      body: `${client.name}: ${note}`.slice(0, 160),
      entityType: 'project', entityId: project.id, projectId: project.id,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('SOW request-changes error:', err)
    return NextResponse.json({ error: 'Could not submit your request. Please try again.' }, { status: 500 })
  }
}
