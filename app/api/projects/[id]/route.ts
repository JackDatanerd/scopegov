import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { roundCurrency } from '@/lib/utils/format'

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
      .from('projects').select('id,name,status,contract_value,currency,sow_documents(status)').eq('id', id)
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
      if (!hasPermission(session, 'MARK_PROJECT_COMPLETE') && body.status === 'Complete')
        return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

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
        changes.contractValue = { from: project.contract_value, to: newValue }
        updates.contract_value = newValue
      }
    }
    if (body.startDate !== undefined) updates.start_date = body.startDate || null
    if (body.internalRef !== undefined) updates.internal_ref = body.internalRef || null

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
