// lib/approvals/engine.ts
//
// Core orchestration for Phase 3 — Approval Chains. Two entry points:
//
//   evaluateApprovalGate()   — called from the SOW/CO send routes BEFORE
//                              the actual send happens. If a workspace has
//                              an active workflow matching this document
//                              type + amount, it creates an approval_request
//                              (idempotently) and tells the caller to halt.
//
//   recordApprovalDecision() — called from /api/approvals/[id]/approve and
//                              /reject. Advances a multi-step chain, or on
//                              final approval, sends the document itself.
//
// Product decision worth flagging explicitly: on final approval, the
// document is auto-sent rather than requiring the original requester to
// come back and click Send a second time. This mirrors how approval
// routing works in tools like DocuSign — the whole point of the gate is
// "don't let this reach the client without sign-off," not "make the
// sender do the send action twice." It also avoids an approved-but-never-
// sent CO/SOW silently rotting in a workspace. If that assumption turns
// out to be wrong for how agencies actually work, this is the one place
// to change it — everything downstream just checks the return value.

import { logAudit } from '@/lib/utils/audit'
import { getMembersWithRole, filterByNotificationPreference } from '@/lib/utils/permissions-query'
import { sendApprovalRequestedEmail, sendApprovalDecisionEmail } from '@/lib/email/templates'
import { sendSowDocument } from '@/lib/documents/send-sow'
import { sendCoDocument } from '@/lib/documents/send-co'
import { hasPermission } from '@/lib/auth/session'
import type { SessionUser } from '@/lib/supabase/types'

export type ApprovalDocumentType = 'sow' | 'co'

interface WorkflowStepRow {
  step_order: number
  approver_role_id: string | null
  approver_user_id: string | null
}

// ── GATE ─────────────────────────────────────────────────────────
interface GateParams {
  workspaceId: string
  documentType: ApprovalDocumentType
  documentId: string
  projectId: string
  projectName: string
  amount: number
  currency: string
  documentTitle: string
  requestedBy: { id: string; name: string; email: string }
}

export interface GateResult {
  requiresApproval: boolean
  approvalRequestId?: string
}

export async function evaluateApprovalGate(service: any, params: GateParams): Promise<GateResult> {
  const { workspaceId, documentType, documentId } = params

  // Idempotency: a pending request for this exact document already covers
  // us — return it rather than creating a duplicate. Backstopped by the
  // partial unique index in the migration for the concurrent case.
  const { data: existingPending } = await service
    .from('approval_requests')
    .select('id')
    .eq('document_type', documentType)
    .eq('document_id', documentId)
    .eq('status', 'pending')
    .maybeSingle()
  if (existingPending) return { requiresApproval: true, approvalRequestId: existingPending.id }

  const { data: workflows } = await service
    .from('approval_workflows')
    .select('id, threshold_amount, threshold_currency')
    .eq('workspace_id', workspaceId)
    .eq('document_type', documentType)
    .eq('is_active', true)

  // Best match = highest threshold the document's amount still clears.
  // A NULL threshold is a catch-all and sorts last, so a more specific
  // tiered rule always wins over a blanket one when both would apply.
  // FIX (re-audit): a thresholded workflow is only comparable against a
  // document in the SAME currency — see migration 023's comment. A
  // "$10,000" threshold has no defensible meaning against a JPY or KES
  // amount, so a currency-mismatched thresholded workflow no longer
  // matches at all (rather than comparing raw digits across currencies).
  // Currency-agnostic (threshold_amount == null, "applies to every
  // document of this type") workflows are unaffected — there's no amount
  // being compared for them.
  const matching = (workflows || [])
    .filter((w: any) =>
      w.threshold_amount == null ||
      (w.threshold_currency === params.currency && params.amount >= Number(w.threshold_amount))
    )
    .sort((a: any, b: any) => {
      if (a.threshold_amount == null) return 1
      if (b.threshold_amount == null) return -1
      return Number(b.threshold_amount) - Number(a.threshold_amount)
    })

  const workflow = matching[0]
  if (!workflow) return { requiresApproval: false }

  const { data: steps } = await service
    .from('approval_workflow_steps')
    .select('step_order, approver_role_id, approver_user_id')
    .eq('workflow_id', workflow.id)
    .order('step_order', { ascending: true })

  if (!steps || steps.length === 0) return { requiresApproval: false }

  const { data: request, error: insertErr } = await service
    .from('approval_requests')
    .insert({
      workspace_id:  workspaceId,
      workflow_id:   workflow.id,
      document_type: documentType,
      document_id:   documentId,
      project_id:    params.projectId,
      requested_by:  params.requestedBy.id,
      status:        'pending',
      current_step:  1,
      total_steps:   steps.length,
      context: {
        title:        params.documentTitle,
        amount:       params.amount,
        currency:     params.currency,
        project_name: params.projectName,
      },
    })
    .select('id')
    .single()

  // Fail closed, not open: if we can't durably record that this document
  // is now gated, the send route must NOT proceed as if it weren't.
  if (insertErr || !request) {
    throw new Error('Failed to create approval request — send halted for safety')
  }

  await service.from('approval_steps').insert(
    steps.map((s: WorkflowStepRow) => ({
      request_id:       request.id,
      step_order:       s.step_order,
      approver_role_id: s.approver_role_id,
      approver_user_id: s.approver_user_id,
      status:           'pending',
    }))
  )

  await logAudit(service, {
    workspaceId,
    actorId: params.requestedBy.id, actorEmail: params.requestedBy.email, actorName: params.requestedBy.name,
    eventType: 'approval.requested',
    entityType: documentType === 'sow' ? 'sow' : 'change_order',
    entityId: documentId, entityName: params.documentTitle,
    metadata: { workflow_id: workflow.id, approval_request_id: request.id, total_steps: steps.length },
  })

  await notifyStepApprovers(service, {
    workspaceId, requestId: request.id, step: steps[0],
    documentType, documentTitle: params.documentTitle,
    projectName: params.projectName, amount: params.amount, currency: params.currency,
    requestedBy: params.requestedBy, totalSteps: steps.length,
  })

  return { requiresApproval: true, approvalRequestId: request.id }
}

// ── DECISION ─────────────────────────────────────────────────────
interface DecisionParams {
  requestId: string
  actor: SessionUser
  decision: 'approved' | 'rejected'
  note?: string
}

export type DecisionResult =
  | { ok: true; status: 'pending' | 'approved' | 'rejected'; autoSent?: boolean }
  | { ok: false; error: string; status: number }

export async function recordApprovalDecision(service: any, params: DecisionParams): Promise<DecisionResult> {
  const { data: request } = await service
    .from('approval_requests')
    .select('id, workspace_id, workflow_id, document_type, document_id, project_id, requested_by, status, current_step, total_steps, context')
    .eq('id', params.requestId)
    .eq('workspace_id', params.actor.workspaceId)
    .single()

  if (!request) return { ok: false, error: 'Approval request not found', status: 404 }
  if (request.status !== 'pending') return { ok: false, error: 'This request has already been decided', status: 400 }

  const { data: step } = await service
    .from('approval_steps')
    .select('id, step_order, approver_role_id, approver_user_id, status')
    .eq('request_id', request.id)
    .eq('step_order', request.current_step)
    .single()

  if (!step || step.status !== 'pending') return { ok: false, error: 'This step has already been decided', status: 400 }

  if (!hasPermission(params.actor, 'APPROVE_DOCUMENTS'))
    return { ok: false, error: 'Missing permission: APPROVE_DOCUMENTS', status: 403 }

  // Belt-and-braces: holding the blanket permission isn't enough — you
  // must also be the specific approver assigned to THIS step (the named
  // user, or any active member currently holding the assigned role).
  // Otherwise anyone with APPROVE_DOCUMENTS could jump ahead of a chain
  // they were never part of.
  let eligible = false
  if (step.approver_user_id) {
    eligible = step.approver_user_id === params.actor.id
  } else if (step.approver_role_id) {
    const { data: member } = await service
      .from('workspace_members')
      .select('role_id')
      .eq('workspace_id', params.actor.workspaceId)
      .eq('user_id', params.actor.id)
      .eq('status', 'active')
      .maybeSingle()
    eligible = member?.role_id === step.approver_role_id
  }
  if (!eligible) return { ok: false, error: 'You are not an approver for this step', status: 403 }

  const now = new Date().toISOString()
  const documentLabel = request.document_type === 'sow' ? 'SOW' : 'Change order'
  const docTitle       = request.context?.title || documentLabel
  const projectName    = request.context?.project_name || ''

  // FIX (re-audit, critical race-condition finding): this is the exact
  // read-then-write pattern that got an explicit CAS guard everywhere else
  // in the app (SOW/CO sign, decline, accept, countersign) after a
  // double-click or two near-simultaneous triggers turned out to be a real
  // risk — but the engine's own decision path, on the busiest multi-user
  // surface in the product (a role-based step can have several eligible
  // approvers), never got the same guard. Two people (or one double-click)
  // approving the same step at once could both pass the `step.status
  // !== 'pending'` read above and both reach here; if it's the final step,
  // both branches below would independently fire the auto-send, emailing
  // the client twice with two different tokens (only the last write's
  // stays valid). Guard the actual write and bail if someone already won.
  const { data: decided } = await service.from('approval_steps').update({
    status: params.decision, decided_by: params.actor.id, decided_at: now, note: params.note || null,
  }).eq('id', step.id).eq('status', 'pending').select('id').maybeSingle()

  if (!decided) return { ok: false, error: 'This step has already been decided', status: 409 }

  const { data: requester } = await service
    .from('users').select('id, name, email').eq('id', request.requested_by).maybeSingle()

  if (params.decision === 'rejected') {
    await service.from('approval_requests').update({
      status: 'rejected', decided_at: now, updated_at: now,
    }).eq('id', request.id)

    await logAudit(service, {
      workspaceId: params.actor.workspaceId,
      actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
      eventType: 'approval.rejected',
      entityType: request.document_type === 'sow' ? 'sow' : 'change_order',
      entityId: request.document_id, entityName: docTitle,
      metadata: { approval_request_id: request.id, step: step.step_order, note: params.note || null },
    })

    if (requester) {
      await notifyRequester(service, {
        workspaceId: params.actor.workspaceId, requester, decision: 'rejected',
        documentLabel, docTitle, projectId: request.project_id, projectName,
        decidedByName: params.actor.name, note: params.note,
      })
    }
    return { ok: true, status: 'rejected' }
  }

  // Approved this step — either advance to the next one, or (if this was
  // the last step) close out the chain and send the document.
  if (request.current_step < request.total_steps) {
    const nextStepOrder = request.current_step + 1
    await service.from('approval_requests').update({
      current_step: nextStepOrder, updated_at: now,
    }).eq('id', request.id)

    await logAudit(service, {
      workspaceId: params.actor.workspaceId,
      actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
      eventType: 'approval.step_approved',
      entityType: request.document_type === 'sow' ? 'sow' : 'change_order',
      entityId: request.document_id, entityName: docTitle,
      metadata: { approval_request_id: request.id, step: step.step_order, note: params.note || null },
    })

    const { data: nextStep } = await service
      .from('approval_steps')
      .select('step_order, approver_role_id, approver_user_id')
      .eq('request_id', request.id).eq('step_order', nextStepOrder).single()

    if (nextStep && requester) {
      await notifyStepApprovers(service, {
        workspaceId: params.actor.workspaceId, requestId: request.id, step: nextStep,
        documentType: request.document_type, documentTitle: docTitle,
        projectName, amount: request.context?.amount || 0, currency: request.context?.currency || 'USD',
        requestedBy: { id: requester.id, name: requester.name, email: requester.email },
        totalSteps: request.total_steps,
      })
    }
    return { ok: true, status: 'pending' }
  }

  await service.from('approval_requests').update({
    status: 'approved', decided_at: now, updated_at: now,
  }).eq('id', request.id)

  await logAudit(service, {
    workspaceId: params.actor.workspaceId,
    actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
    eventType: 'approval.approved',
    entityType: request.document_type === 'sow' ? 'sow' : 'change_order',
    entityId: request.document_id, entityName: docTitle,
    metadata: { approval_request_id: request.id, step: step.step_order, note: params.note || null },
  })

  let autoSent = false
  if (requester) {
    const sendParams = {
      workspaceId: params.actor.workspaceId,
      actorId: requester.id, actorEmail: requester.email, actorName: requester.name,
      approvalRequestId: request.id,
    }
    const result = request.document_type === 'sow'
      ? await sendSowDocument(service, { sowId: request.document_id, ...sendParams })
      : await sendCoDocument(service, { coId: request.document_id, ...sendParams })
    autoSent = result.ok
    if (!result.ok) console.error('Auto-send after final approval failed:', result.error)
  }

  if (requester) {
    await notifyRequester(service, {
      workspaceId: params.actor.workspaceId, requester, decision: 'approved',
      documentLabel, docTitle, projectId: request.project_id, projectName,
      decidedByName: params.actor.name, note: params.note, autoSent,
    })
  }

  return { ok: true, status: 'approved', autoSent }
}

// ── CANCELLATION ─────────────────────────────────────────────────
// Called when the underlying draft is withdrawn/deleted while an approval
// chain is still in flight — a pending request left dangling on a document
// that no longer exists (or is no longer awaiting send) is a dead end for
// whoever it's assigned to, so it's closed out explicitly rather than left
// to rot.
export async function cancelApprovalRequest(service: any, params: {
  documentType: ApprovalDocumentType
  documentId: string
  workspaceId: string
  actorId: string
  actorEmail: string
  actorName: string
  reason?: string
}) {
  const { data: request } = await service
    .from('approval_requests')
    .select('id')
    .eq('document_type', params.documentType)
    .eq('document_id', params.documentId)
    .eq('status', 'pending')
    .maybeSingle()
  if (!request) return

  const now = new Date().toISOString()
  // FIX (re-audit): no CAS here either — a cancel racing a genuine
  // approve/reject decision landing in between the read above and this
  // write could blindly overwrite a real decision back to 'cancelled'.
  // Lower-likelihood than the decision-vs-decision race above, but same
  // root cause. If someone else's decision won the race, leave it be.
  const { data: cancelled } = await service.from('approval_requests').update({
    status: 'cancelled', decided_at: now, updated_at: now,
  }).eq('id', request.id).eq('status', 'pending').select('id').maybeSingle()
  if (!cancelled) return
  await service.from('approval_steps').update({ status: 'skipped' })
    .eq('request_id', request.id).eq('status', 'pending')

  await logAudit(service, {
    workspaceId: params.workspaceId,
    actorId: params.actorId, actorEmail: params.actorEmail, actorName: params.actorName,
    eventType: 'approval.cancelled',
    entityType: params.documentType === 'sow' ? 'sow' : 'change_order',
    entityId: params.documentId,
    metadata: { approval_request_id: request.id, reason: params.reason || null },
  })
}

// ── REMINDERS ────────────────────────────────────────────────────
// Called by the approval-stall cron for requests that have sat on the
// same step for longer than the reminder window — re-notifies whoever
// the CURRENT step is assigned to, exactly as if the step had just
// become active.
export async function sendApprovalReminder(service: any, requestId: string): Promise<boolean> {
  const { data: request } = await service
    .from('approval_requests')
    .select('id, workspace_id, document_type, current_step, total_steps, context, requested_by')
    .eq('id', requestId).eq('status', 'pending').single()
  if (!request) return false

  const { data: step } = await service
    .from('approval_steps')
    .select('step_order, approver_role_id, approver_user_id')
    .eq('request_id', requestId).eq('step_order', request.current_step).single()
  if (!step) return false

  const { data: requester } = await service
    .from('users').select('id, name, email').eq('id', request.requested_by).maybeSingle()
  if (!requester) return false

  await notifyStepApprovers(service, {
    workspaceId: request.workspace_id, requestId: request.id, step,
    documentType: request.document_type, documentTitle: request.context?.title || '',
    projectName: request.context?.project_name || '', amount: request.context?.amount || 0,
    currency: request.context?.currency || 'USD',
    requestedBy: { id: requester.id, name: requester.name, email: requester.email },
    totalSteps: request.total_steps,
  })
  return true
}

// ── LOOKUP ───────────────────────────────────────────────────────
export async function getPendingApprovalForDocument(
  service: any, documentType: ApprovalDocumentType, documentId: string
): Promise<{ id: string; current_step: number; total_steps: number } | null> {
  const { data } = await service
    .from('approval_requests')
    .select('id, current_step, total_steps')
    .eq('document_type', documentType)
    .eq('document_id', documentId)
    .eq('status', 'pending')
    .maybeSingle()
  return data || null
}

// ── NOTIFICATION HELPERS ─────────────────────────────────────────
async function notifyStepApprovers(service: any, args: {
  workspaceId: string; requestId: string; step: WorkflowStepRow
  documentType: ApprovalDocumentType; documentTitle: string
  projectName: string; amount: number; currency: string
  requestedBy: { id: string; name: string; email: string }
  totalSteps: number
}) {
  let recipients: Array<{ id: string; name: string; email: string }> = []
  if (args.step.approver_user_id) {
    const { data: u } = await service.from('users')
      .select('id, name, email').eq('id', args.step.approver_user_id).maybeSingle()
    if (u) recipients = [u]
  } else if (args.step.approver_role_id) {
    recipients = await getMembersWithRole(service, args.workspaceId, args.step.approver_role_id)
  }
  recipients = await filterByNotificationPreference(service, args.workspaceId, 'approval_requested', recipients)
  if (recipients.length === 0) return

  const documentLabel = args.documentType === 'sow' ? 'SOW' : 'Change order'

  try {
    await service.from('notifications').insert(recipients.map(r => ({
      workspace_id: args.workspaceId,
      recipient_id: r.id,
      type:         'approval_requested',
      title:        `${documentLabel} awaiting your approval`,
      body:         `${args.requestedBy.name} wants to send ${args.documentTitle} on ${args.projectName}.`,
      entity_type:  'approval_request',
      entity_id:    args.requestId,
    })))
  } catch { /* never let a notification failure break the approval flow */ }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  await Promise.all(recipients.map(r =>
    sendApprovalRequestedEmail({
      to: r.email, approverName: r.name,
      documentLabel, documentTitle: args.documentTitle, projectName: args.projectName,
      amount: args.amount, currency: args.currency,
      stepNumber: args.step.step_order, totalSteps: args.totalSteps,
      requestedByName: args.requestedBy.name,
      url: `${appUrl}/approvals?highlight=${args.requestId}`,
    }).catch(e => console.error('approval requested email failed:', e))
  ))
}

async function notifyRequester(service: any, args: {
  workspaceId: string
  requester: { id: string; name: string; email: string }
  decision: 'approved' | 'rejected'
  documentLabel: string; docTitle: string; projectId: string; projectName: string
  decidedByName: string; note?: string; autoSent?: boolean
}) {
  try {
    await service.from('notifications').insert({
      workspace_id: args.workspaceId,
      recipient_id: args.requester.id,
      type:         `approval_${args.decision}`,
      title:        `${args.documentLabel} ${args.decision}`,
      body:         `${args.decidedByName} ${args.decision} ${args.docTitle}${args.autoSent ? ' — sent to client' : ''}.`,
      entity_type:  'project',
      entity_id:    args.projectId,
    })
  } catch { /* non-fatal */ }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  try {
    await sendApprovalDecisionEmail({
      to: args.requester.email, requesterName: args.requester.name,
      decision: args.decision, documentLabel: args.documentLabel, documentTitle: args.docTitle,
      projectName: args.projectName, decidedByName: args.decidedByName, note: args.note,
      url: `${appUrl}/projects/${args.projectId}`, autoSent: args.autoSent,
    })
  } catch (e) { console.error('approval decision email failed:', e) }
}
