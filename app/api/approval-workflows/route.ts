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
        id, document_type, name, threshold_amount, threshold_currency, is_active, created_at,
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
    // FIX (re-audit): threshold_amount was compared against a document's
    // amount with no currency awareness at all — see migration 023.
    // Required whenever a threshold is actually set (a currency-agnostic
    // "applies to every document" workflow has no amount to denominate).
    const thresholdCurrency: string | null = thresholdAmount != null
      ? (body?.thresholdCurrency || 'USD').toUpperCase()
      : null
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

    // FIX (deep audit, section 5 re-pass): nothing stopped two active,
    // threshold-less ("catches every document of this type") workflows
    // from existing side by side. evaluateApprovalGate() sorts NULL
    // thresholds last and just takes the first match, so the second
    // catch-all rule an admin creates silently never fires — with no
    // warning that it's dead on arrival. A tiered rule (with a threshold)
    // stacking on top of a catch-all is the actual intended design (see
    // the sort comment in lib/approvals/engine.ts) and isn't blocked here
    // — only the truly ambiguous case of two unconditional rules.
    if (thresholdAmount == null) {
      const { count: dupeCatchAll } = await (service as any)
        .from('approval_workflows').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).eq('document_type', documentType)
        .eq('is_active', true).is('threshold_amount', null)
      if ((dupeCatchAll || 0) > 0) {
        return NextResponse.json({
          error: `An active catch-all ${documentType === 'sow' ? 'SOW' : 'change order'} workflow already exists (applies to every document, no threshold). Add a value threshold to this one, or edit the existing rule instead.`,
        }, { status: 409 })
      }
    }

    // FIX (deep audit, section 5): approverRoleId/approverUserId were
    // inserted with no check that they actually belong to this workspace.
    // The UI only ever offers valid options so this wasn't reachable
    // through normal use, but it's the only mutation in the whole Settings
    // surface that trusted a client-supplied foreign-key id with zero
    // ownership check — everywhere else in this file (workspace_id
    // scoping, permission gates) that check is deliberate. Belt-and-
    // suspenders against a stale/tampered request wiring a step to a role
    // or person outside this workspace.
    const roleIds = steps.map(s => s.approverRoleId).filter(Boolean) as string[]
    const userIds = steps.map(s => s.approverUserId).filter(Boolean) as string[]
    if (roleIds.length) {
      const { count } = await (service as any)
        .from('roles').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).in('id', roleIds)
      if ((count || 0) !== new Set(roleIds).size)
        return NextResponse.json({ error: 'One or more selected roles are not part of this workspace' }, { status: 400 })
    }
    if (userIds.length) {
      const { count } = await (service as any)
        .from('workspace_members').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).eq('status', 'active').in('user_id', userIds)
      if ((count || 0) !== new Set(userIds).size)
        return NextResponse.json({ error: 'One or more selected approvers are not active members of this workspace' }, { status: 400 })
    }

    const { data: workflow, error: insertErr } = await (service as any)
      .from('approval_workflows')
      .insert({
        workspace_id: session.workspaceId,
        document_type: documentType,
        name,
        threshold_amount: thresholdAmount,
        threshold_currency: thresholdCurrency,
        is_active: true,
        created_by: session.id,
      })
      .select('id')
      .single()

    if (insertErr || !workflow)
      return NextResponse.json({ error: insertErr?.message || 'Could not create workflow' }, { status: 500 })

    // FIX (deep audit, section 5 re-pass): this insert's result was
    // discarded — a failure here left an ACTIVE workflow row with zero
    // steps. evaluateApprovalGate() explicitly treats a zero-step workflow
    // as "no approval needed" (lib/approvals/engine.ts), so the failure
    // mode wasn't a visible error, it was a silently unguarded approval
    // gate that looked configured. Check the error and roll back the
    // parent row rather than leave a broken, falsely-active workflow
    // behind.
    const { error: stepsErr } = await (service as any).from('approval_workflow_steps').insert(
      steps.map((s, i) => ({
        workflow_id: workflow.id,
        step_order: i + 1,
        approver_role_id: s.approverRoleId || null,
        approver_user_id: s.approverUserId || null,
      }))
    )
    if (stepsErr) {
      await (service as any).from('approval_workflows').delete().eq('id', workflow.id)
      return NextResponse.json({ error: 'Could not save approval steps — try again' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'approval_workflow.created', entityType: 'approval_workflow',
      entityId: workflow.id, entityName: name,
      metadata: { document_type: documentType, threshold_amount: thresholdAmount, threshold_currency: thresholdCurrency, steps: steps.length },
    })

    return NextResponse.json({ ok: true, id: workflow.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
