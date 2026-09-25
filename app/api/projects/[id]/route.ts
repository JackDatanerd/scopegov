import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { getPendingApprovalForDocument, cancelApprovalRequest } from '@/lib/approvals/engine'
import { isTerminalStatus } from '@/lib/utils/project-status'
import {
  parseProjectName, parseOptionalText, parseProjectType, parseContractValue,
  parseCurrencyCode, parseStartDate, parseRetainerMonths,
  MAX_PROJECT_DISC, MAX_PROJECT_REF,
} from '@/lib/utils/project-input'

// PATCH edits a project's details and pauses/resumes it.
//
// Projects & Dashboard deep audit — what changed here:
//  * Only Active <-> Stalled can be set by hand. Every other status is driven
//    by a workflow (SOW sent/signed/declined, complete, archive, unarchive,
//    reopen). The old code validated only the TARGET status, so a Complete or
//    Archived project could be moved back to Active (bypassing the archive/
//    complete permission), and an Active project with a signed SOW could be
//    pushed back to Draft.
//  * A Complete/Archived project is read-only here (reopen it first).
//  * Every field is validated with the same parsers POST uses. Before, a
//    whitespace-only name was stored, NaN contract values were sent to
//    Postgres, and a bad `stallReason` violated a CHECK constraint.
//  * The UPDATE's `{ error }` was never read, so a rejected write still
//    returned { ok: true } and logged an audit entry for a change that did not
//    happen. It is checked now.
//  * Soft-deleted projects are invisible to this route (they were still
//    readable, editable and re-deletable).
//  * Every changed field lands in the audit metadata (subtitle, dates and
//    reference used to produce an empty `changes`).

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }   = await params
    const session  = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const service = createServiceClient()

    // Editing a project (and pausing/resuming it) is a CREATE_PROJECTS action.
    // Completing/archiving have their own routes and permission.
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_PROJECTS' }, { status: 403 })

    const { data: project } = await (service as any)
      .from('projects')
      .select('id,name,disc,status,stall_reason,type,client_id,currency,contract_value,start_date,internal_ref,retainer_duration_months,sow_documents(id,status)')
      .eq('id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null).maybeSingle()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (isTerminalStatus(project.status))
      return NextResponse.json({
        error: `This project is ${project.status.toLowerCase()} and read-only. Reopen it first to make changes.`,
      }, { status: 409 })

    const sows: Array<{ id: string; status: string }> = project.sow_documents || []
    const updates: Record<string, unknown> = {}
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    let statusChanged = false

    // ── Status: manual pause / resume only ────────────────────
    if (body.status !== undefined && body.status !== project.status) {
      if (body.status === 'Complete')
        return NextResponse.json({
          error: 'Use POST /api/projects/[id]/complete to mark a project complete — it checks for unresolved change orders and closes open flags first.',
        }, { status: 400 })
      if (body.status === 'Archived')
        return NextResponse.json({
          error: 'Use POST /api/projects/[id]/archive to archive a project — it can only be reached from Complete.',
        }, { status: 400 })

      const isPause  = project.status === 'Active'  && body.status === 'Stalled'
      const isResume = project.status === 'Stalled' && body.status === 'Active'
      if (!isPause && !isResume)
        return NextResponse.json({
          error: `A project can only be paused (Active → Stalled) or resumed (Stalled → Active) by hand. "${project.status}" → "${body.status}" happens through the SOW workflow.`,
        }, { status: 400 })

      if (isResume && project.stall_reason === 'sow_unsigned' && !sows.some(s => s.status === 'signed'))
        return NextResponse.json({
          error: 'This project stalled because its SOW was never signed. Resend the SOW (or get it signed) — it resumes automatically.',
        }, { status: 409 })

      updates.status = body.status
      updates.stall_reason = isPause ? 'manual' : null
      statusChanged = true
      changes.status = { from: project.status, to: body.status }
    }

    // ── Details ───────────────────────────────────────────────
    if (body.name !== undefined) {
      const p = parseProjectName(body.name)
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      if (p.value !== project.name) { updates.name = p.value; changes.name = { from: project.name, to: p.value } }
    }
    if (body.disc !== undefined) {
      const p = parseOptionalText(body.disc, 'Subtitle', MAX_PROJECT_DISC)
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      if (p.value !== (project.disc || null)) { updates.disc = p.value; changes.disc = { from: project.disc || null, to: p.value } }
    }
    if (body.startDate !== undefined) {
      const p = parseStartDate(body.startDate)
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      if (p.value !== (project.start_date || null)) { updates.start_date = p.value; changes.startDate = { from: project.start_date || null, to: p.value } }
    }
    if (body.internalRef !== undefined) {
      const p = parseOptionalText(body.internalRef, 'Internal reference', MAX_PROJECT_REF)
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      if (p.value !== (project.internal_ref || null)) { updates.internal_ref = p.value; changes.internalRef = { from: project.internal_ref || null, to: p.value } }
    }

    // Client / type / currency define what the SOW is *about*: only editable
    // while no SOW document exists (i.e. before the SOW step of the wizard).
    const structuralEdit = body.clientId !== undefined || body.type !== undefined || body.currency !== undefined
    if (structuralEdit && sows.length > 0)
      return NextResponse.json({
        error: 'The client, project type and currency can no longer be changed because a SOW already exists for this project.',
      }, { status: 409 })

    let effectiveType: string = project.type
    if (body.type !== undefined && body.type !== project.type) {
      const p = parseProjectType(body.type)
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      updates.type = p.value
      changes.type = { from: project.type, to: p.value }
      effectiveType = p.value
      if (p.value !== 'retainer' && project.retainer_duration_months !== null) {
        updates.retainer_duration_months = null
        changes.retainerDurationMonths = { from: project.retainer_duration_months, to: null }
      }
    }
    if (body.currency !== undefined) {
      const p = parseCurrencyCode(body.currency)
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      if (p.value !== project.currency) { updates.currency = p.value; changes.currency = { from: project.currency, to: p.value } }
    }
    if (body.clientId !== undefined && body.clientId !== project.client_id) {
      if (typeof body.clientId !== 'string')
        return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      const { data: client } = await (service as any)
        .from('clients').select('id, status').eq('id', body.clientId).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      if (client.status === 'archived')
        return NextResponse.json({ error: 'That client is archived. Restore it first.' }, { status: 409 })
      updates.client_id = client.id
      changes.clientId = { from: project.client_id, to: client.id }
    }

    // ── Contract value ────────────────────────────────────────
    if (body.contractValue !== undefined) {
      const p = parseContractValue(body.contractValue)
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      const newValue = p.value
      if (newValue !== Number(project.contract_value)) {
        // A signed SOW binds the client to the value: it changes through a CO.
        if (sows.some(s => s.status === 'signed'))
          return NextResponse.json({
            error: 'This project has a signed SOW — use a change order to adjust the contract value.',
          }, { status: 409 })
        // A SOW out for signature quotes the current value: changing it would
        // leave the client signing a number that no longer matches the project.
        if (sows.some(s => ['awaiting_signature', 'changes_requested'].includes(s.status)))
          return NextResponse.json({
            error: 'A SOW is currently out for signature at the existing contract value — withdraw it before changing the value, then send the client the revised SOW.',
          }, { status: 409 })
        // A draft SOW sitting in an approval chain would be approved at the old value.
        for (const sow of sows) {
          if (sow.status !== 'draft') continue
          if (await getPendingApprovalForDocument(service, 'sow', sow.id))
            return NextResponse.json({
              error: 'A SOW on this project has a pending approval request — cancel it before changing the contract value, then resend.',
            }, { status: 409 })
        }
        changes.contractValue = { from: Number(project.contract_value), to: newValue }
        updates.contract_value = newValue
      }
    }

    // ── Retainer duration (retainer projects only) ────────────
    // FIX (Projects & Dashboard deep audit, flagship finding): for a fixed-term
    // retainer, effective contract value = contract_value (monthly rate) ×
    // retainer_duration_months (see lib/utils/contract-value.ts's
    // baseContractValue) — so changing the duration changes the project's
    // total value exactly as directly as changing contractValue does. The
    // block above gates contractValue behind three checks (blocked outright
    // once a SOW is signed; blocked while a SOW is out for signature; blocked
    // while a draft SOW has a pending approval request) specifically because
    // a signed/quoted/approval-pending SOW binds the client to a number that
    // must only move through a governed change order. This field had none of
    // those three checks, so — as long as the project wasn't Complete/
    // Archived — anyone with plain CREATE_PROJECTS could silently re-price a
    // retainer with a signed SOW by editing only its duration (bounded 1-60
    // months by parseRetainerMonths, so up to a 60x multiple of the monthly
    // rate), with no CO, no approval chain, no client re-acceptance, and no
    // audit trail beyond an ordinary project.updated row. There is already a
    // fully governed path for this exact change: a change order with
    // isRetainerRenewal true + renewalTermMonths (approval-gated, client-
    // accepted) — only once THAT clears does lib/documents/finalize-co.ts
    // write the new retainer_duration_months onto the project. Mirror the
    // contractValue block's three guards here so this field can't bypass them.
    if (body.retainerDurationMonths !== undefined && effectiveType === 'retainer') {
      const p = parseRetainerMonths(body.retainerDurationMonths)
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })
      if (p.value !== project.retainer_duration_months) {
        if (sows.some(s => s.status === 'signed'))
          return NextResponse.json({
            error: 'This project has a signed SOW — use a change order to adjust the retainer duration.',
          }, { status: 409 })
        if (sows.some(s => ['awaiting_signature', 'changes_requested'].includes(s.status)))
          return NextResponse.json({
            error: 'A SOW is currently out for signature at the existing retainer term — withdraw it before changing the duration, then send the client the revised SOW.',
          }, { status: 409 })
        for (const sow of sows) {
          if (sow.status !== 'draft') continue
          if (await getPendingApprovalForDocument(service, 'sow', sow.id))
            return NextResponse.json({
              error: 'A SOW on this project has a pending approval request — cancel it before changing the retainer duration, then resend.',
            }, { status: 409 })
        }
        changes.retainerDurationMonths = { from: project.retainer_duration_months, to: p.value }
        updates.retainer_duration_months = p.value
      }
    }

    if (Object.keys(updates).length === 0)
      return NextResponse.json({ ok: true, unchanged: true })

    updates.updated_at = new Date().toISOString()

    // Guard the write: still not deleted, and — for a pause/resume — still in
    // the status we validated against (a stall cron or SOW send may have moved
    // it since we read the row).
    let q = (service as any).from('projects').update(updates)
      .eq('id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null)
    if (statusChanged) q = q.eq('status', project.status)
    const { data: written, error: updErr } = await q.select('id')
    if (updErr) {
      console.error('Project update error:', updErr)
      return NextResponse.json({ error: 'Could not save the changes. Please try again.' }, { status: 500 })
    }
    if (!written || written.length === 0)
      return NextResponse.json({ error: 'This project changed while you were editing it. Refresh and try again.' }, { status: 409 })

    // Audit. `changes` is { field: { from, to } }; the status event's readers (Dashboard feed, project
    // Activity tab) look for a flat `metadata.to`, which this row never carried — so every pause/resume
    // rendered as "status changed to " with nothing after it. The flat from/to are written alongside the
    // structured `status` diff. And when a status change rides along with other edits, the other edits
    // get their own project.updated row instead of disappearing behind the status event.
    const auditBase = {
      workspaceId: session.workspaceId,
      actorId:     session.id,
      actorEmail:  session.email,
      actorName:   session.name,
      entityType:  'project' as const,
      entityId:    id,
      entityName:  (updates.name as string) || project.name,
    }
    if (statusChanged) {
      await logAudit(service, {
        ...auditBase, eventType: 'project.status_changed',
        metadata: { status: changes.status, from: project.status, to: body.status },
      })
      const { status: _status, ...otherChanges } = changes
      if (Object.keys(otherChanges).length > 0)
        await logAudit(service, { ...auditBase, eventType: 'project.updated', metadata: otherChanges })
    } else {
      await logAudit(service, { ...auditBase, eventType: 'project.updated', metadata: changes })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Project update error:', err)
    return NextResponse.json({ error: 'Could not save the changes' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'DELETE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: DELETE_PROJECTS' }, { status: 403 })

    const service = createServiceClient()
    // Already-deleted projects are simply "not found" (a second DELETE used to
    // succeed and write a second project.deleted audit row).
    const { data: project } = await (service as any)
      .from('projects').select('id,name,status,sow_documents(status)')
      .eq('id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null).maybeSingle()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Only Draft/Intake projects (nothing sent to a client yet) can be deleted.
    if (!['Draft','Intake'].includes(project.status))
      return NextResponse.json({ error: 'Only Draft or Intake projects can be deleted' }, { status: 400 })
    if ((project.sow_documents || []).some((s: any) => s.status === 'signed'))
      return NextResponse.json({ error: 'Project has a signed SOW — archive instead' }, { status: 400 })

    // Status re-checked in the write itself so a SOW send between the read and
    // this update can't leave a soft-deleted project with a live SOW.
    const { data: deleted, error: delErr } = await (service as any).from('projects')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null)
      .in('status', ['Draft', 'Intake'])
      .select('id')
    if (delErr) {
      console.error('Project delete error:', delErr)
      return NextResponse.json({ error: 'Could not delete the project' }, { status: 500 })
    }
    if (!deleted || deleted.length === 0)
      return NextResponse.json({ error: 'This project changed and can no longer be deleted. Refresh and try again.' }, { status: 409 })

    // A deleted project's documents can still be sitting in an approval chain.
    // Left pending, they stayed on every approver's Approvals page (and in the
    // approval-stall cron's nag list) for a project that no longer exists, and
    // could even be approved — which would auto-send a document for a deleted
    // project. Cancel them (the engine notifies the current approver).
    try {
      const { data: pending } = await (service as any).from('approval_requests')
        .select('document_type, document_id')
        .eq('workspace_id', session.workspaceId).eq('project_id', id)
        // FIX (section-11 audit, pass 2): also the "approved but the send failed"
        // state — it kept showing in the Approvals banner, sidebar badge and
        // dashboard for a deleted project, and offered a retry that would try to
        // send a document for it.
        .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
      for (const r of (pending || [])) {
        try {
          await cancelApprovalRequest(service, {
            documentType: r.document_type, documentId: r.document_id,
            workspaceId: session.workspaceId, actorId: session.id,
            actorEmail: session.email, actorName: session.name,
            reason: 'Project deleted',
          })
        } catch (e) { console.error('Project delete: could not cancel approval request:', e) }
      }
    } catch (e) { console.error('Project delete: approval cleanup failed (non-fatal):', e) }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.deleted', entityType: 'project',
      entityId: id, entityName: project.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Project delete error:', err)
    return NextResponse.json({ error: 'Could not delete the project' }, { status: 500 })
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    const { data: project } = await (service as any)
      .from('projects')
      .select('id,name,type,status,contract_value,currency,start_date,clients(id,name,email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null).maybeSingle()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // The project page withholds these from members who lack the permission;
    // the API returned them regardless (contract value and client email).
    const safe = { ...project }
    if (!hasPermission(session, 'VIEW_FINANCIALS')) safe.contract_value = null
    if (!hasPermission(session, 'VIEW_CLIENT_DATA') && safe.clients) safe.clients = { ...safe.clients, email: null }
    return NextResponse.json({ project: safe })
  } catch (err) {
    console.error('Project fetch error:', err)
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}
