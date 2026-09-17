export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

function canManage(session: any) {
  return hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!canManage(session)) return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: existing } = await (service as any)
      .from('approval_workflows').select('id, name, document_type, is_active, threshold_amount, threshold_currency')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!existing) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })

    const body = await request.json()
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof body?.isActive === 'boolean') patch.is_active = body.isActive
    if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim()
    if (body?.thresholdAmount !== undefined) {
      // FIX (deep audit, Settings re-pass): POST /api/approval-workflows
      // requires thresholdAmount to be finite and non-negative — this edit
      // path had no equivalent check, so a negative or non-numeric value
      // could be saved by editing an existing workflow even though
      // creating one that way was already blocked.
      if (body.thresholdAmount !== '' && body.thresholdAmount != null) {
        const n = Number(body.thresholdAmount)
        if (!Number.isFinite(n) || n < 0)
          return NextResponse.json({ error: 'Threshold must be a positive number' }, { status: 400 })
        patch.threshold_amount = n
      } else {
        patch.threshold_amount = null
      }
    }
    // FIX (re-audit): see migration 023 / api/approval-workflows/route.ts —
    // threshold_currency must travel with threshold_amount. Resolve the
    // effective amount (either what's being patched now, or what's
    // already stored) to decide whether a currency is required at all.
    const effectiveAmount = patch.threshold_amount !== undefined ? patch.threshold_amount : existing.threshold_amount
    if (effectiveAmount == null) {
      patch.threshold_currency = null
    } else if (body?.thresholdCurrency !== undefined) {
      patch.threshold_currency = (body.thresholdCurrency || 'USD').toUpperCase()
    } else if (!existing.threshold_currency) {
      patch.threshold_currency = 'USD' // amount is being set for the first time with no currency supplied
    }

    // FIX (deep audit, section 5 re-pass): same duplicate-catch-all guard
    // as POST — check the state this edit would *result in* (active +
    // threshold null), not just the fields present on this request, since
    // either flipping is_active on or clearing the threshold on an
    // otherwise-unchanged row can create the same silent-collision.
    const resultingActive    = 'is_active' in patch ? (patch.is_active as boolean) : existing.is_active
    const resultingThreshold = 'threshold_amount' in patch ? patch.threshold_amount : existing.threshold_amount
    if (resultingActive && resultingThreshold == null) {
      const { count: dupeCatchAll } = await (service as any)
        .from('approval_workflows').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).eq('document_type', existing.document_type)
        .eq('is_active', true).is('threshold_amount', null).neq('id', id)
      if ((dupeCatchAll || 0) > 0) {
        return NextResponse.json({
          error: `An active catch-all ${existing.document_type === 'sow' ? 'SOW' : 'change order'} workflow already exists. Add a value threshold to this one, or deactivate the other rule first.`,
        }, { status: 409 })
      }
    }

    await (service as any).from('approval_workflows').update(patch).eq('id', id)

    // Replacing steps wholesale is simplest-correct here: workflow edits
    // are infrequent admin actions, not a high-frequency path worth a
    // diffing algorithm, and this guarantees step_order stays contiguous.
    if (Array.isArray(body?.steps)) {
      const steps: Array<{ approverRoleId?: string; approverUserId?: string }> = body.steps
      for (const s of steps) {
        if ((!s.approverRoleId && !s.approverUserId) || (s.approverRoleId && s.approverUserId))
          return NextResponse.json({ error: 'Each step needs exactly one approver — a role or a person' }, { status: 400 })
      }
      // FIX (deep audit, section 5): same ownership check added to POST —
      // see the comment there for why.
      //
      // FIX (section-11 audit, flagship finding): same APPROVE_DOCUMENTS
      // check added to POST /api/approval-workflows — an edit could
      // otherwise reassign a step to a role/person who can't act on it,
      // exactly the same silent-dead-end failure mode, invisible to the
      // stall-cron's escalation. See the comment on POST for the full
      // explanation.
      const roleIds = steps.map(s => s.approverRoleId).filter(Boolean) as string[]
      const userIds = steps.map(s => s.approverUserId).filter(Boolean) as string[]
      if (roleIds.length) {
        const { data: roleRows } = await (service as any)
          .from('roles').select('id, name, permissions')
          .eq('workspace_id', session.workspaceId).in('id', roleIds)
        if ((roleRows?.length || 0) !== new Set(roleIds).size)
          return NextResponse.json({ error: 'One or more selected roles are not part of this workspace' }, { status: 400 })
        const roleCantApprove = (roleRows || []).find((r: any) => r.permissions?.APPROVE_DOCUMENTS !== true)
        if (roleCantApprove)
          return NextResponse.json({
            error: `The "${roleCantApprove.name}" role doesn't have the Approve documents permission — grant it first, or pick a different role.`,
          }, { status: 400 })
      }
      if (userIds.length) {
        const { data: memberRows } = await (service as any)
          .from('workspace_members').select('user_id, effective_permissions, users!workspace_members_user_id_fkey(name)')
          .eq('workspace_id', session.workspaceId).eq('status', 'active').in('user_id', userIds)
        if ((memberRows?.length || 0) !== new Set(userIds).size)
          return NextResponse.json({ error: 'One or more selected approvers are not active members of this workspace' }, { status: 400 })
        const memberCantApprove = (memberRows || []).find((m: any) => m.effective_permissions?.APPROVE_DOCUMENTS !== true)
        if (memberCantApprove)
          return NextResponse.json({
            error: `${memberCantApprove.users?.name || 'That member'} doesn't have the Approve documents permission — grant it first, or pick a different approver.`,
          }, { status: 400 })
      }
      await (service as any).from('approval_workflow_steps').delete().eq('workflow_id', id)
      if (steps.length > 0) {
        // FIX (deep audit, section 5 re-pass): same unchecked insert as
        // POST /api/approval-workflows — a failure here (after the old
        // steps were already deleted) left an active workflow with zero
        // steps, which evaluateApprovalGate() silently treats as "no
        // approval needed." Surface the failure instead of pretending the
        // edit succeeded; the workflow is deactivated so it can't gate
        // (or fail to gate) anything while its steps are in a broken
        // state, and the admin can retry the edit.
        const { error: stepsErr } = await (service as any).from('approval_workflow_steps').insert(
          steps.map((s, i) => ({
            workflow_id: id,
            step_order: i + 1,
            approver_role_id: s.approverRoleId || null,
            approver_user_id: s.approverUserId || null,
          }))
        )
        if (stepsErr) {
          await (service as any).from('approval_workflows')
            .update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id)
          return NextResponse.json({
            error: 'Could not save the updated approval steps — this workflow has been paused to avoid running with no approvers. Please try editing it again.',
          }, { status: 500 })
        }
      }
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'approval_workflow.updated', entityType: 'approval_workflow',
      entityId: id, entityName: (patch.name as string) || existing.name,
      metadata: { fields: Object.keys(patch) },
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
    if (!canManage(session)) return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: existing } = await (service as any)
      .from('approval_workflows').select('id, name')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!existing) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })

    // If this workflow has ever produced a real approval request, keep it
    // for audit history — deactivate instead of deleting out from under
    // the trail Phase 1's audit export relies on.
    const { count } = await (service as any)
      .from('approval_requests')
      .select('id', { count: 'exact', head: true })
      .eq('workflow_id', id)

    if ((count || 0) > 0) {
      await (service as any).from('approval_workflows')
        .update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id)
      await logAudit(service, {
        workspaceId: session.workspaceId,
        actorId: session.id, actorEmail: session.email, actorName: session.name,
        eventType: 'approval_workflow.deactivated', entityType: 'approval_workflow',
        entityId: id, entityName: existing.name,
        metadata: { reason: 'has approval history — deactivated instead of deleted' },
      })
      return NextResponse.json({ ok: true, deactivatedInstead: true })
    }

    await (service as any).from('approval_workflows').delete().eq('id', id)
    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'approval_workflow.deleted', entityType: 'approval_workflow',
      entityId: id, entityName: existing.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
