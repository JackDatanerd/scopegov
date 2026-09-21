import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { cancelApprovalRequest } from '@/lib/approvals/engine'

// FIX (Projects & Dashboard deep audit, flagship finding): SOW/CO sends and
// CO-counter acceptance now refuse outright on a Complete/Archived project
// (see lib/documents/send-sow.ts, send-co.ts, accept-co-counter.ts) — but a
// pending approval_requests row created BEFORE completion isn't touched by
// that; it just sits there until an approver decides it, same shape as the
// bug DELETE /api/projects/[id] already guards against (see its own
// approval-cleanup block below). Left alone, an approver deciding on it
// after completion would call the now-guarded send function, get a
// rejection, and the request would silently sit in the "approved but
// failed to send" limbo forever with a confusing reason attached — instead
// of the approver just never seeing a live request for a project that's
// already closed out. 'invoice' is deliberately excluded: billing after
// completion is a normal, legitimate workflow (the final invoice is
// usually created and sent AFTER delivery), so a pending invoice approval
// should still resolve normally post-completion.
const SCOPE_CHANGE_DOCUMENT_TYPES = ['sow', 'co', 'co_counter']

// Change orders that are still live or need a decision. 'expired' is here to
// match the Complete button in ProjectDetail, which already refused to
// complete over an expired CO — the API let it through.
const BLOCKING_CO_STATUSES = ['awaiting_response', 'countered', 'stalled', 'awaiting_countersignature', 'expired']

// Guardian flags that are still open work. borderline_review (a flag waiting
// for a human to confirm/dismiss) used to be left behind on a completed
// project, where the flag-stall cron kept reminding people about it.
const OPEN_FLAG_STATUSES = ['open', 'borderline_review']

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MARK_PROJECT_COMPLETE'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()

    if (!(await canReadProject(service, session, id)))
      return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { data: project } = await (service as any)
      .from('projects')
      .select('id,name,status,change_orders(id,title,status),guardian_flags(id,status)')
      .eq('id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null).maybeSingle()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (project.status !== 'Active')
      return NextResponse.json({ error: 'Only Active projects can be marked complete' }, { status: 400 })

    const blockingCos = (project.change_orders || []).filter((co: any) => BLOCKING_CO_STATUSES.includes(co.status))
    if (blockingCos.length > 0) {
      return NextResponse.json({
        error: `${blockingCos.length} change order${blockingCos.length !== 1 ? 's' : ''} must be resolved before marking complete`,
        blockingCos: blockingCos.map((co: any) => ({ id: co.id, title: co.title, status: co.status })),
      }, { status: 409 })
    }

    const now = new Date().toISOString()

    // Move the project FIRST, guarded on the status we validated (a stall cron
    // or SOW action may have moved it since the read). The old order closed
    // the flags first and ignored the project update's result, so a failed or
    // raced update left a still-Active project with all its flags closed and
    // returned ok.
    const { data: moved, error: moveErr } = await (service as any).from('projects')
      .update({ status: 'Complete', updated_at: now })
      .eq('id', id).eq('workspace_id', session.workspaceId).eq('status', 'Active').is('deleted_at', null)
      .select('id')
    if (moveErr) {
      console.error('Project complete error:', moveErr)
      return NextResponse.json({ error: 'Could not mark the project complete' }, { status: 500 })
    }
    if (!moved || moved.length === 0)
      return NextResponse.json({ error: 'This project changed. Refresh and try again.' }, { status: 409 })

    // Close remaining flags. If that fails, put the project back rather than
    // leave a Complete project with live flags.
    const openFlags = (project.guardian_flags || []).filter((f: any) => OPEN_FLAG_STATUSES.includes(f.status))
    if (openFlags.length > 0) {
      const { error: flagErr } = await (service as any).from('guardian_flags')
        .update({
          status:       'closed',
          close_reason: `Project marked complete by ${session.name}`,
          resolved_at:  now,
          updated_at:   now,
        })
        .in('id', openFlags.map((f: any) => f.id))
      if (flagErr) {
        console.error('Project complete: closing flags failed, reverting:', flagErr)
        await (service as any).from('projects')
          .update({ status: 'Active', updated_at: new Date().toISOString() })
          .eq('id', id).eq('status', 'Complete')
        return NextResponse.json({ error: 'Could not close the open scope flags, so the project was not completed. Please try again.' }, { status: 500 })
      }
    }

    // See SCOPE_CHANGE_DOCUMENT_TYPES comment above — cancel any pending
    // SOW/CO/CO-counter approval requests now that the project is closed
    // out, mirroring DELETE's own cleanup. Non-fatal: the project has
    // already moved and flags are already closed by this point.
    let scopeApprovalsCancelled = 0
    try {
      const { data: pending } = await (service as any).from('approval_requests')
        .select('document_type, document_id')
        .eq('workspace_id', session.workspaceId).eq('project_id', id)
        // Includes approved-but-send-failed requests: once the project is complete
        // a SOW/CO retry can never succeed, and the request would sit un-cancellable.
        .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
        .in('document_type', SCOPE_CHANGE_DOCUMENT_TYPES)
      for (const r of (pending || [])) {
        try {
          await cancelApprovalRequest(service, {
            documentType: r.document_type, documentId: r.document_id,
            workspaceId: session.workspaceId, actorId: session.id,
            actorEmail: session.email, actorName: session.name,
            reason: 'Project marked complete',
          })
          scopeApprovalsCancelled++
        } catch (e) { console.error('Project complete: could not cancel approval request:', e) }
      }
    } catch (e) { console.error('Project complete: approval cleanup failed (non-fatal):', e) }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.completed', entityType: 'project',
      entityId: id, entityName: project.name,
      metadata: { flags_auto_closed: openFlags.length, scope_approvals_cancelled: scopeApprovalsCancelled },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Project complete error:', err)
    return NextResponse.json({ error: 'Could not mark the project complete' }, { status: 500 })
  }
}
