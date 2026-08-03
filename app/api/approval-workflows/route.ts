export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

// Configuring who approves what is treated as a workspace setting rather
// than minting a new permission — MANAGE_WORKSPACE_SETTINGS already gates
// the rest of the workspace's operating config (see settings/page.tsx),
// and APPROVE_DOCUMENTS is reserved for actually acting on a step, not
// deciding the policy.
function canManage(session: any) {
  return hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!canManage(session)) return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: workflows } = await (service as any)
      .from('approval_workflows')
      .select(`
        id, document_type, name, threshold_amount, is_active, created_at,
        approval_workflow_steps(id, step_order, approver_role_id, approver_user_id,
          roles(id, name),
          user:users!approval_workflow_steps_approver_user_id_fkey(id, name, email))
      `)
      .eq('workspace_id', session.workspaceId)
      .order('document_type', { ascending: true })
      .order('threshold_amount', { ascending: false, nullsFirst: false })

    return NextResponse.json({ workflows: workflows || [] })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!canManage(session)) return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body = await request.json()
    const documentType: string = body?.documentType
    const name: string = (body?.name || '').trim()
    const thresholdAmount = body?.thresholdAmount === '' || body?.thresholdAmount == null
      ? null : Number(body.thresholdAmount)
    const steps: Array<{ approverRoleId?: string; approverUserId?: string }> = Array.isArray(body?.steps) ? body.steps : []

    if (!['sow', 'co'].includes(documentType))
      return NextResponse.json({ error: 'documentType must be "sow" or "co"' }, { status: 400 })
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (thresholdAmount != null && (!Number.isFinite(thresholdAmount) || thresholdAmount < 0))
      return NextResponse.json({ error: 'Threshold must be a positive number' }, { status: 400 })
    if (steps.length === 0)
      return NextResponse.json({ error: 'At least one approval step is required' }, { status: 400 })
    for (const s of steps) {
      if ((!s.approverRoleId && !s.approverUserId) || (s.approverRoleId && s.approverUserId))
        return NextResponse.json({ error: 'Each step needs exactly one approver — a role or a person' }, { status: 400 })
    }

    const service = createServiceClient()
    const { data: workflow, error: insertErr } = await (service as any)
      .from('approval_workflows')
      .insert({
        workspace_id: session.workspaceId,
        document_type: documentType,
        name,
        threshold_amount: thresholdAmount,
        is_active: true,
        created_by: session.id,
      })
      .select('id')
      .single()

    if (insertErr || !workflow)
      return NextResponse.json({ error: insertErr?.message || 'Could not create workflow' }, { status: 500 })

    await (service as any).from('approval_workflow_steps').insert(
      steps.map((s, i) => ({
        workflow_id: workflow.id,
        step_order: i + 1,
        approver_role_id: s.approverRoleId || null,
        approver_user_id: s.approverUserId || null,
      }))
    )

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'approval_workflow.created', entityType: 'approval_workflow',
      entityId: workflow.id, entityName: name,
      metadata: { document_type: documentType, threshold_amount: thresholdAmount, steps: steps.length },
    })

    return NextResponse.json({ ok: true, id: workflow.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
