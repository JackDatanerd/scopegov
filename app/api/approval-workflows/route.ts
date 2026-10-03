export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { staleWorkspaceResponse } from '@/lib/utils/workspace-guard'
import { CURRENCIES } from '@/lib/constants/workspace-options'
import { parseWorkflowSteps, parseThresholdAmount } from '@/lib/approvals/workflow-input'

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
    const { data: workflows, error: workflowsErr } = await (service as any)
      .from('approval_workflows')
      .select(`
        id, document_type, name, threshold_amount, threshold_currency, is_active, created_at,
        allow_self_approval, require_distinct_approvers, apply_to_other_currencies,
        approval_workflow_steps(id, step_order, approver_role_id, approver_user_id,
          roles(id, name),
          user:users!approval_workflow_steps_approver_user_id_fkey(id, name, email))
      `)
      .eq('workspace_id', session.workspaceId)
      .order('document_type', { ascending: true })
      .order('threshold_amount', { ascending: false, nullsFirst: false })

    // FIX (section-11 fresh pass, B6): a failed read answered 200 { workflows: [] } — indistinguishable from "no approval
    // rules", the same misread the Settings page fix (Settings pass 5, B2) closed on the server-rendered path.
    if (workflowsErr) {
      console.error('Approval workflows GET read failed:', workflowsErr)
      return NextResponse.json({ error: 'Could not load approval workflows' }, { status: 500 })
    }
    return NextResponse.json({ workflows: workflows || [] })
  } catch (err) {
    // FIX (deep audit, Settings re-pass): raw exception messages were
    // returned straight to the client here — the same info-disclosure
    // pattern already fixed for workspace/settings, /defaults, /branding
    // (and every one of the "seven named workspace-lifecycle routes"),
    // just never applied to this file. Log server-side only.
    console.error('Approval workflows GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!canManage(session)) return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    // FIX (Settings independent pass 7): stale-tab guard — see lib/utils/workspace-guard.ts.
    const stale = staleWorkspaceResponse(body?.workspaceId, session.workspaceId)
    if (stale) return stale
    const documentType: string = body?.documentType
    const name: string = typeof body?.name === 'string' ? body.name.trim() : ''
    // FIX (section-11 audit, pass 1 — B5): shared parsers, see lib/approvals/workflow-input.ts. A threshold
    // must be above zero (0 silently behaved as a catch-all that skipped the duplicate guard below).
    const thresholdParsed = parseThresholdAmount(body?.thresholdAmount)
    const thresholdAmount = thresholdParsed.ok ? thresholdParsed.value : null
    // FIX (re-audit): threshold_amount was compared against a document's
    // amount with no currency awareness at all — see migration 023.
    // Required whenever a threshold is actually set (a currency-agnostic
    // "applies to every document" workflow has no amount to denominate).
    const thresholdCurrency: string | null = thresholdAmount != null
      ? (typeof body?.thresholdCurrency === 'string' && body.thresholdCurrency ? body.thresholdCurrency : 'USD').toUpperCase()
      : null
    const stepsParsed = parseWorkflowSteps(body?.steps)
    // FIX (section-11 audit, pass 2 — feature gaps): three explicit policy
    // switches the engine had no way to express. See migration 069.
    for (const key of ['allowSelfApproval', 'requireDistinctApprovers', 'applyToOtherCurrencies']) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean')
        return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 })
    }
    const allowSelfApproval        = body.allowSelfApproval === true
    const requireDistinctApprovers = body.requireDistinctApprovers === true
    // Only meaningful for a thresholded workflow — a catch-all already gates every currency.
    const applyToOtherCurrencies   = thresholdAmount != null && body.applyToOtherCurrencies === true

    if (!['sow', 'co', 'invoice'].includes(documentType))
      return NextResponse.json({ error: 'documentType must be "sow", "co", or "invoice"' }, { status: 400 })
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (name.length > 120) return NextResponse.json({ error: 'Name must be under 120 characters' }, { status: 400 })
    if (thresholdCurrency && !(CURRENCIES as readonly string[]).includes(thresholdCurrency))
      return NextResponse.json({ error: 'Invalid threshold currency' }, { status: 400 })
    if (!thresholdParsed.ok) return NextResponse.json({ error: thresholdParsed.error }, { status: 400 })
    if (!stepsParsed.ok) return NextResponse.json({ error: stepsParsed.error }, { status: 400 })
    const steps = stepsParsed.steps

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
      const { count: dupeCatchAll, error: dupeCatchAllErr } = await (service as any)
        .from('approval_workflows').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).eq('document_type', documentType)
        .eq('is_active', true).is('threshold_amount', null)
      // FIX (approvals pass 13): a failed count read as "no duplicate"; report it as a retryable failure instead.
      if (dupeCatchAllErr) {
        console.error('Approval workflow POST: duplicate catch-all check failed:', dupeCatchAllErr)
        return NextResponse.json({ error: 'Could not check existing workflows — please try again.' }, { status: 500 })
      }
      if ((dupeCatchAll || 0) > 0) {
        return NextResponse.json({
          error: `An active catch-all ${documentType === 'sow' ? 'SOW' : documentType === 'invoice' ? 'invoice' : 'change order'} workflow already exists (applies to every document, no threshold). Add a value threshold to this one, or edit the existing rule instead.`,
        }, { status: 409 })
      }
    } else {
      // FIX (section-11 fix round, real gap): the catch-all guard above
      // only ever covered the null-threshold case. Two ACTIVE tiered
      // workflows sharing the exact same (document_type, threshold_amount,
      // threshold_currency) hit the identical ambiguity it exists to
      // prevent — evaluateApprovalGate's tie-break (order by id) makes the
      // outcome deterministic, but one of the two rules is then
      // permanently dead with no warning anyone ever gets. Block it the
      // same way.
      const { count: dupeThreshold, error: dupeThresholdErr } = await (service as any)
        .from('approval_workflows').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).eq('document_type', documentType)
        .eq('is_active', true).eq('threshold_amount', thresholdAmount).eq('threshold_currency', thresholdCurrency)
      if (dupeThresholdErr) {
        console.error('Approval workflow POST: duplicate threshold check failed:', dupeThresholdErr)
        return NextResponse.json({ error: 'Could not check existing workflows — please try again.' }, { status: 500 })
      }
      if ((dupeThreshold || 0) > 0) {
        return NextResponse.json({
          error: `An active ${documentType === 'sow' ? 'SOW' : documentType === 'invoice' ? 'invoice' : 'change order'} workflow already exists at this exact threshold (${thresholdCurrency} ${thresholdAmount}) — only one of the two would ever actually apply. Pick a different threshold, or edit the existing rule instead.`,
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
      // FIX (section-11 audit, flagship finding): only ownership was
      // checked here — nothing verified the role actually grants
      // APPROVE_DOCUMENTS. Assigning a step to a role that doesn't (e.g.
      // "Designer") builds an approval chain no one holding that role can
      // ever act on: they'd be notified and show up correctly in "My
      // queue" (that lookup only matches role_id, not the permission),
      // but every Approve/Reject attempt 403s. Worse, this failure mode
      // is invisible to the stall-cron's escalation — it only detects
      // zero *reachable* recipients, not zero *authorized* ones — so a
      // chain like this stalls forever with no automatic alert.
      const { data: roleRows, error: roleRowsErr } = await (service as any)
        .from('roles').select('id, name, permissions')
        .eq('workspace_id', session.workspaceId).in('id', roleIds)
      // FIX (approvals pass 13): a failed read answered 400 "roles are not part of this workspace".
      if (roleRowsErr) {
        console.error('Approval workflow POST: role lookup failed:', roleRowsErr)
        return NextResponse.json({ error: 'Could not verify the selected roles — please try again.' }, { status: 500 })
      }
      if ((roleRows?.length || 0) !== new Set(roleIds).size)
        return NextResponse.json({ error: 'One or more selected roles are not part of this workspace' }, { status: 400 })
      const roleCantApprove = (roleRows || []).find((r: any) => r.permissions?.APPROVE_DOCUMENTS !== true)
      if (roleCantApprove)
        return NextResponse.json({
          error: `The "${roleCantApprove.name}" role doesn't have the Approve documents permission — grant it first, or pick a different role.`,
        }, { status: 400 })
    }
    if (userIds.length) {
      const { data: memberRows, error: memberRowsErr } = await (service as any)
        .from('workspace_members').select('user_id, effective_permissions, users!workspace_members_user_id_fkey(name)')
        .eq('workspace_id', session.workspaceId).eq('status', 'active').in('user_id', userIds)
      if (memberRowsErr) {
        console.error('Approval workflow POST: approver lookup failed:', memberRowsErr)
        return NextResponse.json({ error: 'Could not verify the selected approvers — please try again.' }, { status: 500 })
      }
      if ((memberRows?.length || 0) !== new Set(userIds).size)
        return NextResponse.json({ error: 'One or more selected approvers are not active members of this workspace' }, { status: 400 })
      // FIX (section-11 audit, flagship finding): same gap as the role
      // branch above, for a named-person step — the person picker in
      // Settings (app/(app)/settings/approvals/page.tsx) lists every
      // active member with no permission filter at all, so it was
      // entirely possible to hand-pick someone with no ability to ever
      // approve anything.
      const memberCantApprove = (memberRows || []).find((m: any) => m.effective_permissions?.APPROVE_DOCUMENTS !== true)
      if (memberCantApprove)
        return NextResponse.json({
          error: `${memberCantApprove.users?.name || 'That member'} doesn't have the Approve documents permission — grant it first, or pick a different approver.`,
        }, { status: 400 })
    }

    const { data: workflow, error: insertErr } = await (service as any)
      .from('approval_workflows')
      .insert({
        workspace_id: session.workspaceId,
        document_type: documentType,
        name,
        threshold_amount: thresholdAmount,
        threshold_currency: thresholdCurrency,
        allow_self_approval: allowSelfApproval,
        require_distinct_approvers: requireDistinctApprovers,
        apply_to_other_currencies: applyToOtherCurrencies,
        is_active: true,
        created_by: session.id,
      })
      .select('id')
      .single()

    // FIX (deep audit, Settings re-pass): insertErr?.message — a raw
    // Postgres error — was returned straight to the client. Same
    // info-disclosure pattern as the catch-alls below; log it and hand
    // back a generic message instead.
    if (insertErr || !workflow) {
      // FIX (section-11 audit, pass 1 — B5): two simultaneous saves can both pass the count() guards above;
      // migration 117's partial unique indexes now decide the race — report it as the same 409 the guards give.
      if (insertErr?.code === '23505') {
        return NextResponse.json({
          error: 'An active workflow for this document type already exists at this threshold (or is already a catch-all). Edit or deactivate the existing rule instead.',
        }, { status: 409 })
      }
      if (insertErr) console.error('Approval workflow insert failed:', insertErr)
      return NextResponse.json({ error: 'Could not create workflow' }, { status: 500 })
    }

    // FIX (deep audit, section 5 re-pass): this insert's result was
    // discarded — a failure here left an ACTIVE workflow row with zero
    // steps. (When this was written evaluateApprovalGate() read a zero-step
    // workflow as "no approval needed", a silently unguarded gate that looked
    // configured; it now fails closed with a 409 — see lib/approvals/engine.ts —
    // but a falsely-active, stepless rule would still block every send of this
    // document type, so the rollback below stays.) Check the error and roll back the
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
      console.error('Approval workflow steps insert failed, rolling back workflow', workflow.id, ':', stepsErr)
      const { error: rollbackErr } = await (service as any).from('approval_workflows').delete().eq('id', workflow.id)
      if (rollbackErr) {
        // FIX (deep audit, Settings + Team re-pass round 2 — LOW): the
        // rollback's own result used to be thrown away. If it ALSO fails,
        // the comment right above describes exactly the state this would
        // leave behind — a falsely-active, stepless rule that now blocks
        // every send of this document type (the gate fails closed on it). The row can't be deleted from here
        // (workspace_members/approval_requests may already reference it by
        // now), so fail closed instead: force it inactive, and log loudly
        // enough that a zero-step ACTIVE workflow is never the quiet
        // outcome of this failure mode.
        console.error('Approval workflow rollback ALSO failed — forcing is_active=false for', workflow.id, ':', rollbackErr)
        const { error: deactivateErr } = await (service as any)
          .from('approval_workflows').update({ is_active: false }).eq('id', workflow.id)
        if (deactivateErr) {
          console.error('CRITICAL: could not deactivate orphaned zero-step approval workflow', workflow.id, ':', deactivateErr)
        }
      }
      return NextResponse.json({ error: 'Could not save approval steps — try again' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'approval_workflow.created', entityType: 'approval_workflow',
      entityId: workflow.id, entityName: name,
      metadata: {
        document_type: documentType, threshold_amount: thresholdAmount, threshold_currency: thresholdCurrency, steps: steps.length,
        allow_self_approval: allowSelfApproval, require_distinct_approvers: requireDistinctApprovers, apply_to_other_currencies: applyToOtherCurrencies,
      },
    })

    return NextResponse.json({ ok: true, id: workflow.id })
  } catch (err) {
    console.error('Approval workflows POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
