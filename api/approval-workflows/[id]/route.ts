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
      .from('approval_workflows').select('id, name')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!existing) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })

    const body = await request.json()
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof body?.isActive === 'boolean') patch.is_active = body.isActive
    if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim()
    if (body?.thresholdAmount !== undefined) {
      patch.threshold_amount = body.thresholdAmount === '' || body.thresholdAmount == null
        ? null : Number(body.thresholdAmount)
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
      const roleIds = steps.map(s => s.approverRoleId).filter(Boolean) as string[]
      const userIds = steps.map(s => s.approverUserId).filter(Boolean) as string[]
      if (roleIds.length) {
        const { count: roleCount } = await (service as any)
          .from('roles').select('id', { count: 'exact', head: true })
          .eq('workspace_id', session.workspaceId).in('id', roleIds)
        if ((roleCount || 0) !== new Set(roleIds).size)
          return NextResponse.json({ error: 'One or more selected roles are not part of this workspace' }, { status: 400 })
      }
      if (userIds.length) {
        const { count: userCount } = await (service as any)
          .from('workspace_members').select('id', { count: 'exact', head: true })
          .eq('workspace_id', session.workspaceId).eq('status', 'active').in('user_id', userIds)
        if ((userCount || 0) !== new Set(userIds).size)
          return NextResponse.json({ error: 'One or more selected approvers are not active members of this workspace' }, { status: 400 })
      }
      await (service as any).from('approval_workflow_steps').delete().eq('workflow_id', id)
      if (steps.length > 0) {
        await (service as any).from('approval_workflow_steps').insert(
          steps.map((s, i) => ({
            workflow_id: id,
            step_order: i + 1,
            approver_role_id: s.approverRoleId || null,
            approver_user_id: s.approverUserId || null,
          }))
        )
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
