import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { roundCurrency } from '@/lib/utils/format'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'

// FIX (deep audit, section 7): body.status was written straight through
// with no validation against the actual project_status enum — a malformed
// or malicious direct request could set a project to any string at all.
// Worse, 'Complete' and 'Archived' were both reachable through here even
// though each has its own dedicated route (POST .../complete,
// .../archive) that enforces real lifecycle rules this one never checked:
// completing blocks on open/awaiting change orders and auto-closes open
// guardian flags; archiving requires the project to already be Complete.
// A direct PATCH with a valid MARK_PROJECT_COMPLETE grant could jump
// straight to 'Complete' with unresolved change orders still open, or
// straight to 'Archived' from any status, silently skipping both. Only
// the statuses this route is actually meant to set are allowed here —
// the two lifecycle-gated ones are rejected with a pointer to the route
// that does it safely.
const PATCHABLE_STATUSES = ['Draft', 'Intake', 'Awaiting Signature', 'Changes Requested', 'Active', 'Stalled']

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }   = await params
    const session  = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body    = await request.json()
    const service = createServiceClient()

    // FIX (re-audit, finding — broken access control): this route had no
    // general permission gate at all — only the narrower body.status ===
    // 'Complete' branch below checked anything. canReadProject() confirms
    // visibility, not edit rights, so any member merely assigned to a
    // project (e.g. a Designer role holding only VIEW_OWN_PROJECTS /
    // MARK_DELIVERABLE_STATUS, nothing edit-shaped) could PATCH its name,
    // contract_value, start_date, internal_ref, or status (to anything
    // other than literally 'Complete') with a direct request, even though
    // the frontend never exposed a way to do so. Same reasoning and same
    // permission as clients/[id]'s PATCH: there's no dedicated
    // project-edit permission in the schema, so this reuses
    // CREATE_PROJECTS rather than inventing and seeding a new one.
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_PROJECTS' }, { status: 403 })

    // Verify project belongs to workspace
    const { data: project } = await (service as any)
      .from('projects').select('id,name,status,type,contract_value,currency,retainer_duration_months,sow_documents(id,status)').eq('id', id)
      .eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    let eventType = 'project.updated'
    // FIX (deep audit, section 7): the audit entry for this route only
    // ever logged `{ from: project.status, to: body.status }` — for any
    // edit that wasn't a status change (name, contract value, internal
    // ref...), the audit trail captured nothing about what actually
    // changed. Build it properly instead.
    const changes: Record<string, { from: unknown; to: unknown }> = {}

    if (body.status) {
      if (body.status === 'Complete')
        return NextResponse.json({
          error: 'Use POST /api/projects/[id]/complete to mark a project complete — it checks for unresolved change orders and closes open flags first.',
        }, { status: 400 })
      if (body.status === 'Archived')
        return NextResponse.json({
          error: 'Use POST /api/projects/[id]/archive to archive a project — it can only be reached from Complete.',
        }, { status: 400 })
      if (!PATCHABLE_STATUSES.includes(body.status))
        return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 })

      updates.status = body.status
      eventType = 'project.status_changed'
      changes.status = { from: project.status, to: body.status }

      // BUG-046: clear stallReason when transitioning Stalled → Active
      if (body.status === 'Active' && project.status === 'Stalled') {
        updates.stall_reason = null
      }
      if (body.status === 'Stalled') {
        updates.stall_reason = body.stallReason || 'manual'
      }
    }

    if (body.name && body.name !== project.name) {
      changes.name = { from: project.name, to: body.name }
      updates.name = body.name
    }
    if (body.disc !== undefined) updates.disc = body.disc || null
    if (body.contractValue) {
      const newValue = roundCurrency(parseFloat(body.contractValue))
      if (newValue !== project.contract_value) {
        // FIX (deep audit, section 7 — significant): contract_value feeds
        // the signed SOW PDF, CO drafting, dashboard/portfolio totals, and
        // approval-workflow threshold matching — it isn't cosmetic. This
        // let anyone with CREATE_PROJECTS silently edit it after a SOW was
        // already signed, with no lock and (until the fix above) no audit
        // trail of the change at all. Once a SOW is signed, the contracted
        // value should only move through a Change Order, which has its
        // own approval/audit trail — not a quiet edit here.
        const hasSignedSow = (project.sow_documents || []).some((s: any) => s.status === 'signed')
        if (hasSignedSow) {
          return NextResponse.json({
            error: 'This project has a signed SOW — use a change order to adjust the contract value.',
          }, { status: 409 })
        }
        // FIX (section-9 audit, 9-G5): locking only AFTER signature left
        // the worst window wide open. Both the client portal page and the
        // portal PDF read projects.contract_value live, and the SOW PDF
        // header prints it — so while a SOW is sitting with the client
        // awaiting signature, this endpoint could change the number under
        // them. The client opens a link quoting one contract value, and
        // signs a document quoting another, while the AI-drafted Payment
        // Terms prose inside the SOW still states the original figure. On
        // a governance product that's the exact failure mode the product
        // exists to prevent. Withdraw or reopen the SOW to change the
        // value, then send the client the corrected document.
        const outForSignature = (project.sow_documents || []).some((s: any) =>
          ['awaiting_signature', 'changes_requested'].includes(s.status))
        if (outForSignature) {
          return NextResponse.json({
            error: 'A SOW is currently out for signature at the existing contract value — withdraw it before changing the value, then send the client the revised SOW.',
          }, { status: 409 })
        }
        // FIX (section-11 audit): a gated SOW stays at status:'draft' the
        // entire time it's sitting in an approval chain (see
        // lib/approvals/engine.ts), so neither of the two locks above ever
        // caught it — this route would happily change contract_value out
        // from under a request an approver is actively reviewing. On
        // final approval, sendSowDocument() re-reads contract_value LIVE
        // and sends whatever it finds, so the document that actually
        // reaches the client could differ from the amount the approver
        // signed off on (approval_requests.context.amount is a snapshot,
        // taken at request time, that would now be stale) — and if the
        // SOW uses a milestone payment schedule, that schedule was
        // validated to foot to the OLD value and would no longer match
        // the new one. Same failure class as 9-G5 above, just for the
        // approval window instead of the signature window.
        for (const sow of (project.sow_documents || [])) {
          if (sow.status !== 'draft') continue
          if (await getPendingApprovalForDocument(service, 'sow', sow.id)) {
            return NextResponse.json({
              error: 'A SOW on this project has a pending approval request — cancel it before changing the contract value, then resend.',
            }, { status: 409 })
          }
        }
        changes.contractValue = { from: project.contract_value, to: newValue }
        updates.contract_value = newValue
      }
    }
    if (body.startDate !== undefined) updates.start_date = body.startDate || null
    if (body.internalRef !== undefined) updates.internal_ref = body.internalRef || null

    // FIX (deep audit, section 7 — flagship finding): retainer_duration_months
    // had no write path anywhere in the product — see POST /api/projects
    // for the full explanation. Allow it here too, for retainer projects
    // whose term wasn't set (or needs correcting) after creation.
    if (body.retainerDurationMonths !== undefined && project.type === 'retainer') {
      if (body.retainerDurationMonths === null || body.retainerDurationMonths === '') {
        if (project.retainer_duration_months !== null) {
          changes.retainerDurationMonths = { from: project.retainer_duration_months, to: null }
          updates.retainer_duration_months = null
        }
      } else {
        const parsed = parseInt(body.retainerDurationMonths, 10)
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60)
          return NextResponse.json({ error: 'Retainer duration must be between 1 and 60 months' }, { status: 400 })
        if (parsed !== project.retainer_duration_months) {
          changes.retainerDurationMonths = { from: project.retainer_duration_months, to: parsed }
          updates.retainer_duration_months = parsed
        }
      }
    }

    await (service as any).from('projects').update(updates).eq('id', id)

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId:     session.id,
      actorEmail:  session.email,
      actorName:   session.name,
      eventType,
      entityType:  'project',
      entityId:    id,
      entityName:  project.name,
      metadata:    changes,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
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
    const { data: project } = await (service as any)
      .from('projects').select('id,name,status,sow_documents(status)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Only Draft/Intake with no signed SOW can be soft-deleted
    if (!['Draft','Intake'].includes(project.status))
      return NextResponse.json({ error: 'Only Draft or Intake projects can be deleted' }, { status: 400 })
    if ((project.sow_documents || []).some((s: any) => s.status === 'signed'))
      return NextResponse.json({ error: 'Project has a signed SOW — archive instead' }, { status: 400 })

    await (service as any).from('projects')
      .update({ deleted_at: new Date().toISOString() }).eq('id', id)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.deleted', entityType: 'project',
      entityId: id, entityName: project.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
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
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json({ project })
  } catch { return NextResponse.json({ error: 'Error' }, { status: 500 }) }
}
