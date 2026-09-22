export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { diffFields } from '@/lib/utils/audit-diff'
import { CURRENCIES } from '@/lib/constants/workspace-options'

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
      .from('approval_workflows').select('id, name, document_type, is_active, threshold_amount, threshold_currency, allow_self_approval, require_distinct_approvers, apply_to_other_currencies')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!existing) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    // Everything is validated before anything is written: a rejected edit must
    // leave the workflow exactly as it was.
    const patch: Record<string, unknown> = {}
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean')
        return NextResponse.json({ error: 'isActive must be true or false' }, { status: 400 })
      patch.is_active = body.isActive
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim())
        return NextResponse.json({ error: 'Workflow name is required' }, { status: 400 })
      if (body.name.trim().length > 120)
        return NextResponse.json({ error: 'Workflow name must be under 120 characters' }, { status: 400 })
      patch.name = body.name.trim()
    }
    if (body.thresholdAmount !== undefined) {
      if (body.thresholdAmount !== '' && body.thresholdAmount != null) {
        const n = Number(body.thresholdAmount)
        if (!Number.isFinite(n) || n < 0)
          return NextResponse.json({ error: 'Threshold must be a positive number' }, { status: 400 })
        patch.threshold_amount = n
      } else {
        patch.threshold_amount = null
      }
    }
    // FIX (section-11 audit, pass 2 — feature gaps): policy switches, see migration 069.
    for (const [key, col] of [
      ['allowSelfApproval', 'allow_self_approval'],
      ['requireDistinctApprovers', 'require_distinct_approvers'],
      ['applyToOtherCurrencies', 'apply_to_other_currencies'],
    ] as const) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== 'boolean')
        return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 })
      patch[col] = body[key]
    }
    const effectiveAmount = patch.threshold_amount !== undefined ? patch.threshold_amount : existing.threshold_amount
    if (effectiveAmount == null) {
      if (existing.threshold_currency != null) patch.threshold_currency = null
    } else if (body.thresholdCurrency !== undefined) {
      const currency = typeof body.thresholdCurrency === 'string' && body.thresholdCurrency ? body.thresholdCurrency.toUpperCase() : 'USD'
      if (!(CURRENCIES as readonly string[]).includes(currency))
        return NextResponse.json({ error: 'Invalid threshold currency' }, { status: 400 })
      patch.threshold_currency = currency
    } else if (!existing.threshold_currency) {
      patch.threshold_currency = 'USD' // amount is being set for the first time with no currency supplied
    }

    let steps: Array<{ approverRoleId?: string; approverUserId?: string }> | undefined
    if (body.steps !== undefined) {
      if (!Array.isArray(body.steps) || body.steps.length === 0)
        return NextResponse.json({ error: 'An approval workflow needs at least one approver step' }, { status: 400 })
      if (body.steps.length > 10)
        return NextResponse.json({ error: 'An approval workflow can have at most 10 steps' }, { status: 400 })
      steps = body.steps as typeof steps
      for (const st of steps!) {
        if (!st || typeof st !== 'object' ||
            (typeof st.approverRoleId !== 'string' && typeof st.approverUserId !== 'string') ||
            (st.approverRoleId && st.approverUserId))
          return NextResponse.json({ error: 'Each step needs exactly one approver — a role or a person' }, { status: 400 })
      }
      const roleIds = steps!.map(st => st.approverRoleId).filter(Boolean) as string[]
      const userIds = steps!.map(st => st.approverUserId).filter(Boolean) as string[]
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
    }

    const { count: existingStepCount } = await (service as any)
      .from('approval_workflow_steps').select('id', { count: 'exact', head: true }).eq('workflow_id', id)

    const resultingActive    = 'is_active' in patch ? (patch.is_active as boolean) : existing.is_active
    const resultingThreshold = 'threshold_amount' in patch ? patch.threshold_amount : existing.threshold_amount
    const resultingCurrency  = 'threshold_currency' in patch ? patch.threshold_currency : existing.threshold_currency

    // A workflow with no approvers would let documents through unreviewed.
    if (resultingActive && !steps && (existingStepCount || 0) === 0) {
      return NextResponse.json({ error: 'This workflow has no approver steps. Add at least one approver before activating it.' }, { status: 409 })
    }

    if (resultingActive && resultingThreshold == null) {
      const { count: dupeCatchAll } = await (service as any)
        .from('approval_workflows').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).eq('document_type', existing.document_type)
        .eq('is_active', true).is('threshold_amount', null).neq('id', id)
      if ((dupeCatchAll || 0) > 0) {
        return NextResponse.json({
          error: `An active catch-all ${existing.document_type === 'sow' ? 'SOW' : existing.document_type === 'invoice' ? 'invoice' : 'change order'} workflow already exists. Add a value threshold to this one, or deactivate the other rule first.`,
        }, { status: 409 })
      }
    } else if (resultingActive && resultingThreshold != null) {
      const { count: dupeThreshold } = await (service as any)
        .from('approval_workflows').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).eq('document_type', existing.document_type)
        .eq('is_active', true).eq('threshold_amount', resultingThreshold).eq('threshold_currency', resultingCurrency)
        .neq('id', id)
      if ((dupeThreshold || 0) > 0) {
        return NextResponse.json({
          error: `An active ${existing.document_type === 'sow' ? 'SOW' : existing.document_type === 'invoice' ? 'invoice' : 'change order'} workflow already exists at this exact threshold (${resultingCurrency} ${resultingThreshold}) — only one of the two would ever actually apply. Pick a different threshold, or deactivate the other rule first.`,
        }, { status: 409 })
      }
    }

    // "Also gate other currencies" has no meaning on a catch-all (it already
    // gates every currency) — keep the stored value honest.
    if (resultingThreshold == null && (patch.apply_to_other_currencies === true || existing.apply_to_other_currencies === true))
      patch.apply_to_other_currencies = false

    const before = {
      name: existing.name, is_active: existing.is_active,
      threshold_amount: existing.threshold_amount, threshold_currency: existing.threshold_currency,
      allow_self_approval: existing.allow_self_approval,
      require_distinct_approvers: existing.require_distinct_approvers,
      apply_to_other_currencies: existing.apply_to_other_currencies,
    }
    const { changedKeys, changes } = diffFields(before, patch)
    if (changedKeys.length === 0 && !steps) return NextResponse.json({ ok: true, unchanged: true })

    // Field changes and the step replacement commit together or not at all.
    const { error: rpcErr } = await (service as any).rpc('update_approval_workflow_atomic', {
      p_workspace_id: session.workspaceId,
      p_workflow_id:  id,
      p_patch:        patch,
      p_set_steps:    !!steps,
      p_steps:        steps ?? null,
    })
    if (rpcErr) {
      console.error('update_approval_workflow_atomic failed:', rpcErr)
      return NextResponse.json({ error: 'Could not save this workflow. Nothing was changed — please try again.' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'approval_workflow.updated', entityType: 'approval_workflow',
      entityId: id, entityName: (patch.name as string) || existing.name,
      metadata: {
        fields: [...changedKeys, ...(steps ? ['steps'] : [])],
        changes,
        ...(steps ? { steps: { from: existingStepCount || 0, to: steps.length } } : {}),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    // FIX (deep audit, Settings re-pass): same raw-message leak already
    // fixed for approval-workflows/route.ts (GET/POST) — this PATCH
    // handler was missed. Log server-side only.
    console.error('Approval workflow PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
    const { count, error: countErr } = await (service as any)
      .from('approval_requests')
      .select('id', { count: 'exact', head: true })
      .eq('workflow_id', id)
    // FIX (section-11 audit, pass 2): a failed count read as "no history" and
    // fell through to a delete that the approval_requests FK then rejected —
    // while the route still logged 'deleted' and returned ok. Fail visibly.
    if (countErr) {
      console.error('Approval workflow DELETE history check failed:', countErr)
      return NextResponse.json({ error: 'Could not check this workflow\'s history — nothing was changed.' }, { status: 500 })
    }

    if ((count || 0) > 0) {
      // FIX (deep audit, Settings + Team re-pass round 2 — LOW): this
      // update's result went unchecked — the two other Postgres calls in
      // this very function (the history count just above, and the delete
      // just below) both already check their error and fail visibly; this
      // one didn't, so a failed deactivate still logged
      // 'approval_workflow.deactivated' and returned `ok: true,
      // deactivatedInstead: true` — the workflow stayed exactly as active
      // as it was before the call, with an audit trail and a UI response
      // both claiming otherwise.
      const { error: deactivateErr } = await (service as any).from('approval_workflows')
        .update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id)
      if (deactivateErr) {
        console.error('Approval workflow deactivate failed:', deactivateErr)
        return NextResponse.json({ error: 'Could not deactivate this workflow — nothing was changed. Try again.' }, { status: 500 })
      }
      await logAudit(service, {
        workspaceId: session.workspaceId,
        actorId: session.id, actorEmail: session.email, actorName: session.name,
        eventType: 'approval_workflow.deactivated', entityType: 'approval_workflow',
        entityId: id, entityName: existing.name,
        metadata: { reason: 'has approval history — deactivated instead of deleted' },
      })
      return NextResponse.json({ ok: true, deactivatedInstead: true })
    }

    const { error: delErr } = await (service as any).from('approval_workflows').delete().eq('id', id)
    if (delErr) {
      console.error('Approval workflow delete failed:', delErr)
      return NextResponse.json({ error: 'Could not delete this workflow — it may have gained approval history. Deactivate it instead.' }, { status: 409 })
    }
    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'approval_workflow.deleted', entityType: 'approval_workflow',
      entityId: id, entityName: existing.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Approval workflow DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
