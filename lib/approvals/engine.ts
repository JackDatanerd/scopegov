// lib/approvals/engine.ts
//
// Core orchestration for Phase 3 — Approval Chains. Entry points:
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

import { insertNotificationRows } from '@/lib/utils/notify'
import { logAudit } from '@/lib/utils/audit'
import { getMembersWithRole, filterByNotificationPreference, filterToProjectAccess } from '@/lib/utils/permissions-query'
import { sendApprovalRequestedEmail, sendApprovalDecisionEmail } from '@/lib/email/templates'
import { sendSowDocument } from '@/lib/documents/send-sow'
import { sendCoDocument } from '@/lib/documents/send-co'
import { sendInvoiceDocument } from '@/lib/documents/send-invoice'
import { acceptCoCounter } from '@/lib/documents/accept-co-counter'
import { hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { eligibleApprovers, checkChainFeasibility } from '@/lib/approvals/eligibility'
import { pickWorkflow } from '@/lib/approvals/pick-workflow'

export { pickWorkflow }
import type { SessionUser } from '@/lib/supabase/types'

// FIX (section-11 audit): 'co_counter' added so accept-counter can gate a
// negotiated CO amount through the same threshold engine as an original
// send, without needing its own separate admin-configured workflow — see
// workflowLookupType() below, which maps it back to 'co' for matching
// against a workspace's existing 'co' workflows. It's kept as its own
// document_type on the approval_requests row itself (not silently merged
// into 'co') so recordApprovalDecision() can auto-finalize it correctly
// on final approval — accepting a counter-offer and sending a brand-new
// CO are different actions with different auto-send targets.
//
// FIX (section-12 audit — flagship feature gap): 'invoice' added. This is
// exactly the extension this file's document_type design (free-text on
// the DB side, specifically so this could happen without a migration —
// see the workflow-creation routes) was built to anticipate, but Phase 4a
// shipped without ever wiring it up — invoices had zero approval-gating
// at all until now, the same governance gap the whole engine exists to
// close for SOWs and COs.
export type ApprovalDocumentType = 'sow' | 'co' | 'co_counter' | 'invoice'

// Which document_type an approval_workflows row is configured under, for
// a given request's document_type. Only 'co_counter' differs from itself.
function workflowLookupType(documentType: ApprovalDocumentType): 'sow' | 'co' | 'invoice' {
  return documentType === 'co_counter' ? 'co' : documentType
}

// FIX (section-12 audit): pulled out of the seven near-identical inline
// ternaries scattered through this file (audit_log entityType, the
// requester-facing document label, etc.) — every one of them silently
// treated anything that wasn't 'sow' as a change order, which was
// harmless while 'co_counter' was the only other value but would have
// mislabeled every invoice approval as a "Change order" throughout the
// audit trail and every notification email.
function entityTypeFor(documentType: ApprovalDocumentType): 'sow' | 'change_order' | 'invoice' {
  if (documentType === 'sow') return 'sow'
  if (documentType === 'invoice') return 'invoice'
  return 'change_order'
}
// FIX (fix round, section-11 finding): exported so cron/approval-stall's
// send-failure escalation can build a consistent document label without
// duplicating this mapping.
export function documentLabelFor(documentType: ApprovalDocumentType): string {
  if (documentType === 'sow') return 'SOW'
  if (documentType === 'invoice') return 'Invoice'
  if (documentType === 'co_counter') return 'Change order counter-offer'
  return 'Change order'
}

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

// FIX (section-11 audit, pass 2): the gate used to have exactly two answers
// — "no approval needed" or "a request exists, halt". Two situations fit
// neither and were handled by silently picking one:
//   * a workflow matched but nobody can ever decide it (the requester is the
//     only approver, the approver left, the role lost APPROVE_DOCUMENTS) —
//     a request was created that could never clear, with the document
//     parked behind it and no one told; and a matched workflow with ZERO
//     steps was waved through as "no approval needed" (a silent bypass);
//   * the document already has an approved-but-not-sent request — clicking
//     Send again started a whole second chain.
// `blocked` is the third answer: the send must NOT proceed and no new request
// was created; `error`/`status` are what to hand back to the user. Every
// caller checks it before looking at requiresApproval.
export interface GateResult {
  requiresApproval: boolean
  approvalRequestId?: string
  blocked?: boolean
  error?: string
  status?: number
}

// The one request that currently "owns" a document: still pending, or fully
// approved but stuck waiting for a successful send. At most one can exist
// (approval_requests_one_active_per_doc, migration 069).
async function findActiveRequest(
  service: any, workspaceId: string, documentType: ApprovalDocumentType, documentId: string
): Promise<{ id: string; status: string; send_failed_at: string | null } | null> {
  const { data } = await service
    .from('approval_requests')
    .select('id, status, send_failed_at')
    .eq('workspace_id', workspaceId)
    .eq('document_type', documentType)
    .eq('document_id', documentId)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
    .order('created_at', { ascending: false })
    .limit(1)
  return (data && data[0]) || null
}

function activeRequestResult(active: { id: string; status: string }): GateResult {
  if (active.status === 'pending') return { requiresApproval: true, approvalRequestId: active.id }
  return {
    requiresApproval: true, blocked: true, approvalRequestId: active.id, status: 409,
    error: 'This document was already approved but could not be sent. Open it in Approvals to retry the send — or cancel that request there to start over.',
  }
}

// (workflow selection lives in lib/approvals/pick-workflow.ts so it can be unit-tested)
export async function evaluateApprovalGate(service: any, params: GateParams): Promise<GateResult> {
  const { workspaceId, documentType, documentId } = params

  // Idempotency: a request for this exact document already covers us —
  // return it rather than creating a duplicate.
  const active = await findActiveRequest(service, workspaceId, documentType, documentId)
  if (active) return activeRequestResult(active)

  const { data: workflows } = await service
    .from('approval_workflows')
    .select('id, threshold_amount, threshold_currency, allow_self_approval, require_distinct_approvers, apply_to_other_currencies')
    .eq('workspace_id', workspaceId)
    .eq('document_type', workflowLookupType(documentType))
    .eq('is_active', true)

  const workflow = pickWorkflow(workflows || [], params.amount, params.currency)
  if (!workflow) return { requiresApproval: false }

  const { data: steps } = await service
    .from('approval_workflow_steps')
    .select('step_order, approver_role_id, approver_user_id')
    .eq('workflow_id', workflow.id)
    .order('step_order', { ascending: true })

  // Fail closed: a matching workflow with no steps used to read as "no
  // approval needed" — the document sailed through as if ungoverned while the
  // admin believed a rule was protecting it.
  if (!steps || steps.length === 0) {
    return {
      requiresApproval: true, blocked: true, status: 409,
      error: 'An approval workflow applies to this document but has no approvers configured. An admin needs to fix it in Settings → Approvals before this can be sent.',
    }
  }

  const allowSelfApproval        = workflow.allow_self_approval === true
  const requireDistinctApprovers = workflow.require_distinct_approvers === true

  // Pre-flight: refuse to create a request nobody can decide.
  const feasibility = await checkChainFeasibility(service, {
    workspaceId, projectId: params.projectId, steps,
    requesterId: params.requestedBy.id, allowSelfApproval, requireDistinctApprovers,
  })
  if (!feasibility.ok) return { requiresApproval: true, blocked: true, status: 409, error: feasibility.error }

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
      allow_self_approval:        allowSelfApproval,
      require_distinct_approvers: requireDistinctApprovers,
      context: {
        title:        params.documentTitle,
        amount:       params.amount,
        currency:     params.currency,
        project_name: params.projectName,
      },
    })
    .select('id')
    .single()

  if (insertErr || !request) {
    // A double-click / two tabs racing the unique index: the other request
    // won — that IS the request this send belongs to, not a failure.
    if (insertErr?.code === '23505') {
      const raced = await findActiveRequest(service, workspaceId, documentType, documentId)
      if (raced) return activeRequestResult(raced)
    }
    // Fail closed, not open: if we can't durably record that this document
    // is now gated, the send route must NOT proceed as if it weren't.
    throw new Error('Failed to create approval request — send halted for safety')
  }

  // A partial failure here (a transient DB error) would leave a 'pending'
  // request with no real approval_steps — an approver would be told to decide
  // something recordApprovalDecision() can never find. Fail closed the same
  // way: roll back the orphaned request and halt the send.
  const { error: stepsInsertErr } = await service.from('approval_steps').insert(
    steps.map((s: WorkflowStepRow) => ({
      request_id:       request.id,
      step_order:       s.step_order,
      approver_role_id: s.approver_role_id,
      approver_user_id: s.approver_user_id,
      status:           'pending',
    }))
  )
  if (stepsInsertErr) {
    await service.from('approval_requests').delete().eq('id', request.id)
    throw new Error('Failed to create approval steps — send halted for safety')
  }

  await logAudit(service, {
    workspaceId,
    actorId: params.requestedBy.id, actorEmail: params.requestedBy.email, actorName: params.requestedBy.name,
    eventType: 'approval.requested',
    entityType: entityTypeFor(documentType),
    entityId: documentId, entityName: params.documentTitle,
    metadata: { workflow_id: workflow.id, approval_request_id: request.id, total_steps: steps.length },
  })

  await notifyStepApprovers(service, {
    workspaceId, requestId: request.id, step: steps[0],
    documentType, documentTitle: params.documentTitle,
    projectId: params.projectId, projectName: params.projectName,
    amount: params.amount, currency: params.currency,
    requestedBy: params.requestedBy, totalSteps: steps.length,
    allowSelfApproval,
  })

  return { requiresApproval: true, approvalRequestId: request.id }
}

// ── SEND DISPATCH ────────────────────────────────────────────────
// FIX (section-11 audit, pass 2): the auto-send after a final approval used
// to be a bare `await sendXDocument(...)` with no try/catch, and only ever
// read `result.ok`. Two consequences:
//   * ANY thrown error inside a send (send-invoice never wrapped its
//     document-number assignment the way send-sow/send-co do, and a DB or
//     secret-lookup error can throw anywhere) escaped recordApprovalDecision
//     after the chain had already approved: the approver got a 500 and the
//     request was left approved with no send_failed_at — invisible to the
//     requester, the retry UI and the stall cron. Exactly the limbo
//     migration 053 was written to remove.
//   * A send that "succeeded" but whose client email was rejected by the
//     mail provider (emailSent:false) was reported as "sent to client".
type SendOutcome =
  | { ok: true; emailSent: boolean; emailError?: string }
  | { ok: false; error: string }

async function dispatchSend(
  service: any,
  request: { document_type: ApprovalDocumentType; document_id: string },
  sendParams: { workspaceId: string; actorId: string; actorEmail: string; actorName: string; approvalRequestId: string },
): Promise<SendOutcome> {
  try {
    // 'co_counter' needs its own auto-finalize — it's not a fresh send, it's
    // accepting an already-negotiated counter-offer (routing it through
    // sendCoDocument, which CASes on status:'draft', would silently no-op).
    const result: any = request.document_type === 'sow'
      ? await sendSowDocument(service, { sowId: request.document_id, ...sendParams })
      : request.document_type === 'co_counter'
      ? await acceptCoCounter(service, { coId: request.document_id, ...sendParams })
      : request.document_type === 'invoice'
      ? await sendInvoiceDocument(service, { invoiceId: request.document_id, ...sendParams })
      : await sendCoDocument(service, { coId: request.document_id, ...sendParams })
    if (!result.ok) return { ok: false, error: result.error || 'The send failed.' }
    return { ok: true, emailSent: result.emailSent !== false, emailError: result.emailError }
  } catch (e) {
    console.error('Auto-send threw:', e)
    return { ok: false, error: 'The send failed unexpectedly — retry it, and contact support if it keeps happening.' }
  }
}

function deliveryWarningFor(outcome: SendOutcome): string | null {
  if (!outcome.ok || outcome.emailSent) return null
  return `The document was sent, but the email to the client could not be delivered${outcome.emailError ? ` (${outcome.emailError})` : ''}. Copy the client link from the project and send it to them yourself.`
}

// Records how the auto-send went and lifts the request out of its
// "sending" state (see migration 069). The RPC is one atomic UPDATE; if it
// errors, fall back to a plain guarded update so a transient failure here can't
// leave the request parked in 'pending' with every step already decided.
async function finalizeSend(service: any, requestId: string, outcome: SendOutcome, deliveryWarning: string | null): Promise<boolean> {
  const failedReason = outcome.ok ? null : outcome.error
  const { data, error } = await service.rpc('finalize_approval_send', {
    p_request_id: requestId, p_send_ok: outcome.ok, p_error: failedReason, p_delivery_warning: deliveryWarning,
  })
  if (!error) return data === true
  console.error('finalize_approval_send failed, falling back:', error)
  const now = new Date().toISOString()
  const { data: updated } = await service.from('approval_requests').update({
    status: 'approved', decided_at: now, updated_at: now, sending_started_at: null,
    send_failed_at: outcome.ok ? null : now, send_failed_reason: failedReason,
    delivery_warning: outcome.ok ? deliveryWarning : null,
  }).eq('id', requestId).eq('status', 'pending').select('id').maybeSingle()
  return !!updated
}

// ── DECISION ─────────────────────────────────────────────────────
interface DecisionParams {
  requestId: string
  actor: SessionUser
  decision: 'approved' | 'rejected'
  note?: string
}

export type DecisionResult =
  | { ok: true; status: 'pending' | 'approved' | 'rejected'; autoSent?: boolean; deliveryWarning?: string | null }
  | { ok: false; error: string; status: number }

export async function recordApprovalDecision(service: any, params: DecisionParams): Promise<DecisionResult> {
  const { data: request } = await service
    .from('approval_requests')
    .select('id, workspace_id, workflow_id, document_type, document_id, project_id, requested_by, status, current_step, total_steps, context, allow_self_approval, require_distinct_approvers')
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

  // Holding the blanket permission isn't enough — you must also be the
  // specific approver assigned to THIS step (the named user, or any active
  // member currently holding the assigned role).
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

  // Nobody decides a request they raised themselves — unless the workflow was
  // explicitly configured to allow it (sole-approver / solo-agency workspaces;
  // the flag is snapshotted onto the request so a later edit can't change the
  // rules of a chain already in flight).
  if (request.requested_by === params.actor.id && !request.allow_self_approval)
    return { ok: false, error: 'You requested this — it needs to be decided by someone else', status: 403 }

  // Four-eyes across steps: one person may clear at most one step.
  if (request.require_distinct_approvers) {
    const { data: earlier } = await service
      .from('approval_steps').select('id')
      .eq('request_id', request.id).eq('status', 'approved').eq('decided_by', params.actor.id).limit(1)
    if (earlier && earlier.length > 0)
      return { ok: false, error: 'You already approved an earlier step of this request — a different person needs to approve this one', status: 403 }
  }

  // The decision path must gate on project visibility exactly like every
  // other document-mutating route (canReadProject).
  if (!(await canReadProject(service, params.actor, request.project_id)))
    return { ok: false, error: 'You do not have access to this project', status: 403 }

  const documentLabel = documentLabelFor(request.document_type)
  const docTitle       = request.context?.title || documentLabel
  const projectName    = request.context?.project_name || ''

  // FIX (section-11 audit, pass 2): this used to be five-to-seven sequential
  // writes (step CAS, request status, skip the rest, advance…) with no
  // transaction and no error ever read — supabase-js resolves to {error}
  // rather than throwing, so a failed second write left a step 'approved'
  // with the request stuck, or fired the auto-send while the request still
  // read 'pending'. The whole decision is now one transaction with the request
  // row locked (migration 069), which also serialises two approvers racing
  // on the same step and closes the window where a cancel could be
  // overwritten back to 'approved'.
  const { data: outcome, error: decideErr } = await service.rpc('decide_approval_step', {
    p_request_id: request.id, p_step_id: step.id, p_decision: params.decision,
    p_actor_id: params.actor.id, p_note: params.note || null,
  })
  if (decideErr) {
    console.error('decide_approval_step failed:', decideErr)
    return { ok: false, error: 'Could not record your decision — please try again.', status: 500 }
  }
  if (outcome === 'conflict') return { ok: false, error: 'This step has already been decided', status: 409 }
  if (outcome !== 'rejected' && outcome !== 'advanced' && outcome !== 'final') {
    console.error('decide_approval_step returned an unexpected outcome:', outcome)
    return { ok: false, error: 'Could not record your decision — please try again.', status: 500 }
  }

  const { data: requester } = await service
    .from('users').select('id, name, email').eq('id', request.requested_by).maybeSingle()

  if (outcome === 'rejected') {
    await logAudit(service, {
      workspaceId: params.actor.workspaceId,
      actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
      eventType: 'approval.rejected',
      entityType: entityTypeFor(request.document_type),
      entityId: request.document_id, entityName: docTitle,
      metadata: { approval_request_id: request.id, step: step.step_order, note: params.note || null },
    })

    if (requester) {
      await notifyRequester(service, {
        workspaceId: params.actor.workspaceId, requester, decision: 'rejected',
        documentLabel, docTitle, projectId: request.project_id, projectName,
        decidedByName: params.actor.name, note: params.note, requestId: request.id,
        isCounter: request.document_type === 'co_counter',
      })
    }
    return { ok: true, status: 'rejected' }
  }

  if (outcome === 'advanced') {
    await logAudit(service, {
      workspaceId: params.actor.workspaceId,
      actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
      eventType: 'approval.step_approved',
      entityType: entityTypeFor(request.document_type),
      entityId: request.document_id, entityName: docTitle,
      metadata: { approval_request_id: request.id, step: step.step_order, note: params.note || null },
    })

    const nextStepOrder = request.current_step + 1
    const { data: nextStep } = await service
      .from('approval_steps')
      .select('step_order, approver_role_id, approver_user_id')
      .eq('request_id', request.id).eq('step_order', nextStepOrder).single()

    if (nextStep && requester) {
      await notifyStepApprovers(service, {
        workspaceId: params.actor.workspaceId, requestId: request.id, step: nextStep,
        documentType: request.document_type, documentTitle: docTitle,
        projectId: request.project_id, projectName,
        amount: request.context?.amount || 0, currency: request.context?.currency || 'USD',
        requestedBy: { id: requester.id, name: requester.name, email: requester.email },
        totalSteps: request.total_steps,
        allowSelfApproval: request.allow_self_approval === true,
      })
    }
    // FIX (section-11 audit, pass 2 — feature gap): a multi-step chain used to
    // be silent to the requester until the very last step; they had no way to
    // tell "step 1 of 3 cleared" from "nobody has looked at it".
    if (requester) {
      await notifyRequesterProgress(service, {
        workspaceId: params.actor.workspaceId, requester, documentLabel, docTitle,
        decidedByName: params.actor.name, step: step.step_order, totalSteps: request.total_steps, requestId: request.id,
      })
    }
    return { ok: true, status: 'pending' }
  }

  // outcome === 'final': the last step just cleared. The request is still
  // status 'pending' (with sending_started_at set), so the document's edit
  // lock holds while the send runs — the old code flipped it to 'approved'
  // first, opening a window in which the draft could be edited or deleted
  // between approval and send.
  await logAudit(service, {
    workspaceId: params.actor.workspaceId,
    actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
    eventType: 'approval.approved',
    entityType: entityTypeFor(request.document_type),
    entityId: request.document_id, entityName: docTitle,
    metadata: { approval_request_id: request.id, step: step.step_order, note: params.note || null },
  })

  const sendOutcome: SendOutcome = requester
    ? await dispatchSend(service, request, {
        workspaceId: params.actor.workspaceId,
        actorId: requester.id, actorEmail: requester.email, actorName: requester.name,
        approvalRequestId: request.id,
      })
    : { ok: false, error: 'The person who requested this no longer has an account, so it could not be sent automatically. Cancel this request and send the document again.' }

  const autoSent = sendOutcome.ok
  const sendFailedReason = sendOutcome.ok ? null : sendOutcome.error
  const deliveryWarning = deliveryWarningFor(sendOutcome)
  if (!sendOutcome.ok) console.error('Auto-send after final approval failed:', sendOutcome.error)

  const finalized = await finalizeSend(service, request.id, sendOutcome, deliveryWarning)
  if (!finalized) {
    // Cancelled while the send was in flight — the document may have gone out
    // anyway; leave a trail rather than pretend nothing happened.
    await logAudit(service, {
      workspaceId: params.actor.workspaceId,
      actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
      eventType: 'approval.send_outcome_unrecorded',
      entityType: entityTypeFor(request.document_type),
      entityId: request.document_id, entityName: docTitle,
      metadata: { approval_request_id: request.id, send_ok: sendOutcome.ok },
    })
  }

  if (requester) {
    await notifyRequester(service, {
      workspaceId: params.actor.workspaceId, requester, decision: 'approved',
      documentLabel, docTitle, projectId: request.project_id, projectName,
      decidedByName: params.actor.name, note: params.note, autoSent, sendFailedReason, deliveryWarning,
      requestId: request.id, isCounter: request.document_type === 'co_counter',
    })
  }

  return { ok: true, status: 'approved', autoSent, deliveryWarning }
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
  // FIX (fix round, section-11 flagship finding): this used to match only
  // status='pending' — a request that fully cleared approval but then
  // failed to auto-send (status='approved', send_failed_at set; see
  // migration 053) was invisible to this lookup entirely. That's exactly
  // the state a document sits in while stuck in the send-failure recovery
  // window, and every caller of this function (SOW/CO/invoice DELETE and
  // void/withdraw/close routes) is here specifically to stop the document
  // out from under a live approval concern before destroying/superseding
  // it. Missing this state meant deleting a document in that window left
  // its approval_requests row permanently orphaned — cancelApprovalRequest
  // could never find it (only 'pending' matched), so it just sat there
  // forever pointing at a document that no longer exists: un-cancellable,
  // and a retry would only ever fail looking up a dead document_id.
  // Broadened to match either state; the write below is CAS'd against
  // whichever one it actually read.
  // FIX (section-11 audit, pass 2): `.maybeSingle()` errors when more than one
  // row matches (see getPendingApprovalForDocument), returning null — so the
  // cancel silently did nothing while a chain stayed live. Scoped to the
  // workspace and newest-first instead.
  const { data: requestRows } = await service
    .from('approval_requests')
    .select('id, project_id, current_step, context, status')
    .eq('workspace_id', params.workspaceId)
    .eq('document_type', params.documentType)
    .eq('document_id', params.documentId)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
    .order('created_at', { ascending: false })
    .limit(1)
  const request = requestRows && requestRows[0]
  if (!request) return

  const now = new Date().toISOString()
  // FIX (re-audit): no CAS here either — a cancel racing a genuine
  // approve/reject decision landing in between the read above and this
  // write could blindly overwrite a real decision back to 'cancelled'.
  // Lower-likelihood than the decision-vs-decision race above, but same
  // root cause. If someone else's decision won the race, leave it be.
  // CAS'd against the same status the read above actually found —
  // 'pending' for a live chain, or 'approved' for the send-failure limbo
  // case (guarded further by re-checking send_failed_at isn't null, so a
  // concurrent successful retry-send can't be clobbered back to cancelled).
  const { data: cancelled } = await service.from('approval_requests').update({
    status: 'cancelled', decided_at: now, updated_at: now,
  }).eq('id', request.id)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
    .select('id').maybeSingle()
  if (!cancelled) return

  // FIX (deep audit, notifications section — feature gap): whoever was
  // already notified "awaiting your approval" for the currently-pending
  // step got no follow-up at all when the request died underneath them —
  // their bell/email said it was still pending, and clicking through led
  // to a request that no longer exists. Fetch that step's approver(s)
  // BEFORE marking steps skipped below, same recipient-resolution as
  // notifyStepApprovers, and gated under the same 'approval_requested'
  // preference (a user who's muted approval-request notifications
  // shouldn't be re-notified about one going away either). In-app only —
  // this is a lower-urgency, no-action-needed heads-up, not worth a new
  // email template in its own right.
  const { data: pendingStep } = await service
    .from('approval_steps')
    .select('approver_role_id, approver_user_id')
    .eq('request_id', request.id).eq('step_order', request.current_step).eq('status', 'pending')
    .maybeSingle()

  await service.from('approval_steps').update({ status: 'skipped' })
    .eq('request_id', request.id).eq('status', 'pending')

  if (pendingStep) {
    try {
      let stepRecipients: Array<{ id: string; name: string; email: string }> = []
      if (pendingStep.approver_user_id) {
        const { data: m } = await service
          .from('workspace_members')
          .select('user_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
          .eq('workspace_id', params.workspaceId)
          .eq('user_id', pendingStep.approver_user_id)
          .eq('status', 'active')
          .maybeSingle()
        if (m?.users) {
          stepRecipients = await filterToProjectAccess(
            service, request.project_id, [{ id: m.users.id, name: m.users.name, email: m.users.email }],
            new Map([[m.user_id, m.effective_permissions || {}]])
          )
        }
      } else if (pendingStep.approver_role_id) {
        stepRecipients = await getMembersWithRole(
          service, params.workspaceId, pendingStep.approver_role_id, 25, request.project_id,
          'approval_requested', 'in_app'
        )
      }
      if (pendingStep.approver_user_id && stepRecipients.length) {
        stepRecipients = await filterByNotificationPreference(
          service, params.workspaceId, 'approval_requested', stepRecipients, 'in_app'
        )
      }
      if (stepRecipients.length) {
        const docTitle    = request.context?.title || documentLabelFor(params.documentType)
        const projectName = request.context?.project_name || ''
        await insertNotificationRows(service, stepRecipients.map(r => ({
          workspace_id: params.workspaceId,
          recipient_id: r.id,
          type:         'approval_cancelled',
          title:        'Approval request cancelled',
          body:         `${params.actorName} cancelled the request for ${docTitle}${projectName ? ` on ${projectName}` : ''} — no action needed.`,
          entity_type:  'project',
          entity_id:    request.project_id,
        })))
      }
    } catch { /* never let a notification failure break cancellation */ }
  }

  await logAudit(service, {
    workspaceId: params.workspaceId,
    actorId: params.actorId, actorEmail: params.actorEmail, actorName: params.actorName,
    eventType: 'approval.cancelled',
    entityType: entityTypeFor(params.documentType),
    entityId: params.documentId,
    metadata: { approval_request_id: request.id, reason: params.reason || null },
  })
}

// ── REMINDERS ────────────────────────────────────────────────────
// Called by the approval-stall cron for requests that have sat on the
// same step for longer than the reminder window — re-notifies whoever
// the CURRENT step is assigned to, exactly as if the step had just
// become active.
//
// Returns a real tri-state so the cron can tell "reminded" apart from
// "nobody to remind" (a broken assignment needs a human to fix it).
//
// FIX (section-11 audit, pass 2): the requester is excluded from the
// recipients (unless the workflow allows self-approval). They were counted as
// a reachable approver, so a request whose only eligible approver was the
// requester "reminded" the one person who could never act, every window,
// forever — instead of escalating as 'no_recipients'. The step lookup also
// now requires the step to still be pending: a request whose last step has
// cleared but whose send is in flight has nobody left to remind.
export async function sendApprovalReminder(
  service: any, requestId: string
): Promise<'sent' | 'no_recipients' | 'not_found'> {
  const { data: request } = await service
    .from('approval_requests')
    .select('id, workspace_id, document_type, current_step, total_steps, context, requested_by, project_id, allow_self_approval')
    .eq('id', requestId).eq('status', 'pending').single()
  if (!request) return 'not_found'

  const { data: step } = await service
    .from('approval_steps')
    .select('step_order, approver_role_id, approver_user_id')
    .eq('request_id', requestId).eq('step_order', request.current_step).eq('status', 'pending').maybeSingle()
  if (!step) return 'not_found'

  const { data: requester } = await service
    .from('users').select('id, name, email').eq('id', request.requested_by).maybeSingle()
  if (!requester) return 'not_found'

  const notifiedCount = await notifyStepApprovers(service, {
    workspaceId: request.workspace_id, requestId: request.id, step,
    documentType: request.document_type, documentTitle: request.context?.title || '',
    projectId: request.project_id, projectName: request.context?.project_name || '', amount: request.context?.amount || 0,
    currency: request.context?.currency || 'USD',
    requestedBy: { id: requester.id, name: requester.name, email: requester.email },
    totalSteps: request.total_steps,
    allowSelfApproval: request.allow_self_approval === true,
  })
  return notifiedCount > 0 ? 'sent' : 'no_recipients'
}

// ── RETRY (send_failed_at) ──────────────────────────────────────
// The recovery path for a request that finished approving but whose
// auto-send afterward failed — it re-attempts ONLY the mechanical send,
// against a request that's already 'approved'. It deliberately does NOT go
// anywhere near evaluateApprovalGate: re-running the gate would create a
// brand-new approval_request and re-notify every approver to decide
// something they've already decided.
//
// FIX (section-11 audit, pass 2): two concurrent retries (a double click, two
// tabs) both ran the send; the loser's "already sent" error then overwrote
// the reason on a request that had in fact succeeded. The retry now CLAIMS
// the request first (sending_started_at) and the send runs inside the same
// try/catch as the original auto-send.
export async function retryFailedSend(service: any, params: {
  requestId: string
  workspaceId: string
  actor: { id: string; email: string; name: string }
}): Promise<{ ok: true; deliveryWarning?: string | null } | { ok: false; error: string }> {
  const { data: request } = await service
    .from('approval_requests')
    .select('id, document_type, document_id, project_id, context, status, send_failed_at')
    .eq('id', params.requestId).eq('workspace_id', params.workspaceId).single()

  if (!request) return { ok: false, error: 'Approval request not found' }
  if (request.status !== 'approved' || !request.send_failed_at)
    return { ok: false, error: 'This request has nothing to retry' }

  const claimStamp = new Date().toISOString()
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const { data: claimed } = await service.from('approval_requests')
    .update({ sending_started_at: claimStamp })
    .eq('id', request.id).eq('status', 'approved').not('send_failed_at', 'is', null)
    .or(`sending_started_at.is.null,sending_started_at.lt.${staleBefore}`)
    .select('id')
  if (!claimed || claimed.length === 0)
    return { ok: false, error: 'A retry is already in progress — give it a moment, then refresh.' }

  const outcome = await dispatchSend(service, request, {
    workspaceId: params.workspaceId,
    actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
    approvalRequestId: request.id,
  })

  const now = new Date().toISOString()
  if (outcome.ok) {
    const deliveryWarning = deliveryWarningFor(outcome)
    await service.from('approval_requests').update({
      send_failed_at: null, send_failed_reason: null, sending_started_at: null,
      delivery_warning: deliveryWarning, updated_at: now,
    }).eq('id', request.id)
    await logAudit(service, {
      workspaceId: params.workspaceId,
      actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
      eventType: 'approval.send_retried', entityType: entityTypeFor(request.document_type),
      entityId: request.document_id, entityName: request.context?.title || '',
      metadata: { approval_request_id: request.id, email_delivered: outcome.emailSent },
    })
    return { ok: true, deliveryWarning }
  }

  // Still failing (e.g. the client's email is still missing) — refresh the
  // reason shown in the UI so it reflects whatever's actually wrong now.
  await service.from('approval_requests').update({
    send_failed_reason: outcome.error, sending_started_at: null, updated_at: now,
  }).eq('id', request.id)
  return { ok: false, error: outcome.error }
}

// ── SELF-HEALING ─────────────────────────────────────────────────
// A request is parked 'pending' with sending_started_at set for the few
// seconds an auto-send takes. If the process dies in that window (a deploy, a
// platform timeout) nothing would ever move it on — every step is decided, so
// no approver has anything to act on either. The stall cron calls this to turn
// such a request into the normal, visible, retryable "approved — not sent"
// state.
export async function healStuckSends(service: any, olderThanMinutes = 10): Promise<Array<{ id: string; workspace_id: string }>> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString()
  const { data: stuck } = await service
    .from('approval_requests')
    .select('id, workspace_id, requested_by, project_id, document_type, context')
    .eq('status', 'pending').not('sending_started_at', 'is', null).lt('sending_started_at', cutoff)
    .order('sending_started_at', { ascending: true }).limit(50)

  const healed: Array<{ id: string; workspace_id: string }> = []
  for (const r of stuck || []) {
    const reason = 'The send did not finish (the server may have restarted mid-send). Check whether the document already shows as sent: if it does, cancel this request; otherwise retry the send.'
    const { data: ok } = await service.rpc('finalize_approval_send', {
      p_request_id: r.id, p_send_ok: false, p_error: reason, p_delivery_warning: null,
    })
    if (ok !== true) continue
    healed.push({ id: r.id, workspace_id: r.workspace_id })
    try {
      const [inAppOn] = await filterByNotificationPreference(
        service, r.workspace_id, 'approval_decision', [{ id: r.requested_by }], 'in_app'
      )
      if (inAppOn) {
        await insertNotificationRows(service, [{
          workspace_id: r.workspace_id, recipient_id: r.requested_by, type: 'approval_approved',
          title: `${documentLabelFor(r.document_type)} approved — send didn't finish`,
          body: `${r.context?.title || 'A document'} was approved but the automatic send didn't finish — open it in Approvals to retry.`,
          entity_type: 'approval_request', entity_id: r.id,
        }])
      }
    } catch { /* never let a notification failure stop the heal */ }
  }
  return healed
}

// ── REASSIGN (feature gap) ───────────────────────────────────────
// Steps are snapshotted from the workflow when a request is created, so
// editing the workflow never touches a request already in flight — which meant
// an approver who left, went on leave, or turned out to be the requester left
// the request permanently stuck (the only way out was cancel + resubmit).
// An admin can now hand the CURRENT step to a different person or role.
export async function reassignApprovalStep(service: any, params: {
  requestId: string
  workspaceId: string
  actor: { id: string; name: string; email: string }
  target: { userId?: string | null; roleId?: string | null }
  reason?: string | null
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const { data: request } = await service
    .from('approval_requests')
    .select('id, project_id, document_type, document_id, requested_by, status, current_step, total_steps, context, allow_self_approval, require_distinct_approvers, sending_started_at')
    .eq('id', params.requestId).eq('workspace_id', params.workspaceId).single()
  if (!request) return { ok: false, error: 'Approval request not found', status: 404 }
  if (request.status !== 'pending' || request.sending_started_at)
    return { ok: false, error: 'Only a request that is still waiting on an approver can be reassigned', status: 409 }

  const { data: step } = await service
    .from('approval_steps')
    .select('id, step_order, approver_role_id, approver_user_id, status')
    .eq('request_id', request.id).eq('step_order', request.current_step).single()
  if (!step || step.status !== 'pending')
    return { ok: false, error: 'This step has already been decided', status: 409 }

  const targetUser = params.target.userId || null
  const targetRole = params.target.roleId || null
  if ((targetUser ? 1 : 0) + (targetRole ? 1 : 0) !== 1)
    return { ok: false, error: 'Choose exactly one new approver — a person or a role', status: 400 }
  if ((targetUser && targetUser === step.approver_user_id) || (targetRole && targetRole === step.approver_role_id))
    return { ok: false, error: 'That approver is already assigned to this step', status: 400 }

  let candidates = await eligibleApprovers(service, params.workspaceId, request.project_id, {
    approver_user_id: targetUser, approver_role_id: targetRole,
  })
  if (request.allow_self_approval !== true) candidates = candidates.filter(c => c.id !== request.requested_by)
  if (request.require_distinct_approvers === true) {
    const { data: earlier } = await service
      .from('approval_steps').select('decided_by').eq('request_id', request.id).eq('status', 'approved')
    const already = new Set((earlier || []).map((e: any) => e.decided_by))
    candidates = candidates.filter(c => !already.has(c.id))
  }
  if (candidates.length === 0)
    return { ok: false, error: 'Nobody in that assignment can decide this request — they need the Approve documents permission, access to this project, and (unless this workflow allows it) must not be the person who requested it.', status: 400 }

  const { data: updated } = await service.from('approval_steps')
    .update({ approver_user_id: targetUser, approver_role_id: targetRole })
    .eq('id', step.id).eq('status', 'pending').select('id').maybeSingle()
  if (!updated) return { ok: false, error: 'This step has already been decided', status: 409 }

  const now = new Date().toISOString()
  await service.from('approval_requests')
    .update({ updated_at: now, reminder_count: 0, escalated_at: null })
    .eq('id', request.id).eq('status', 'pending')

  await logAudit(service, {
    workspaceId: params.workspaceId,
    actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
    eventType: 'approval.step_reassigned',
    entityType: entityTypeFor(request.document_type),
    entityId: request.document_id, entityName: request.context?.title || '',
    metadata: {
      approval_request_id: request.id, step: step.step_order,
      from: { user_id: step.approver_user_id, role_id: step.approver_role_id },
      to: { user_id: targetUser, role_id: targetRole },
      reason: params.reason || null,
    },
  })

  const { data: requester } = await service
    .from('users').select('id, name, email').eq('id', request.requested_by).maybeSingle()
  if (requester) {
    await notifyStepApprovers(service, {
      workspaceId: params.workspaceId, requestId: request.id,
      step: { step_order: step.step_order, approver_role_id: targetRole, approver_user_id: targetUser },
      documentType: request.document_type, documentTitle: request.context?.title || '',
      projectId: request.project_id, projectName: request.context?.project_name || '',
      amount: request.context?.amount || 0, currency: request.context?.currency || 'USD',
      requestedBy: { id: requester.id, name: requester.name, email: requester.email },
      totalSteps: request.total_steps, allowSelfApproval: request.allow_self_approval === true,
    })
  }
  return { ok: true }
}

// ── LOOKUP ───────────────────────────────────────────────────────
// Every caller of this function is an edit-lock — "don't let the document
// change while an approval concern is outstanding": a request that is
// pending (including the few seconds an auto-send runs — see
// decide_approval_step) or fully approved but waiting on a successful send.
//
// FIX (section-11 audit, pass 2): this used `.maybeSingle()`, which ERRORS
// when more than one row matches (a stale approved-not-sent request plus a
// second chain started by a stray Send click). The error was ignored, `data`
// came back null, and the edit-lock silently vanished while a chain was live.
// migration 069's unique index makes two matches impossible; this read is now
// also safe by construction (newest row wins) if one ever appears.
export async function getPendingApprovalForDocument(
  service: any, documentType: ApprovalDocumentType, documentId: string
): Promise<{ id: string; current_step: number; total_steps: number; status: string; send_failed_at: string | null; sending_started_at: string | null } | null> {
  const { data } = await service
    .from('approval_requests')
    .select('id, current_step, total_steps, status, send_failed_at, sending_started_at')
    .eq('document_type', documentType)
    .eq('document_id', documentId)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
    .order('created_at', { ascending: false })
    .limit(1)
  return (data && data[0]) || null
}

// ── NOTIFICATION HELPERS ─────────────────────────────────────────
async function notifyStepApprovers(service: any, args: {
  workspaceId: string; requestId: string; step: WorkflowStepRow
  documentType: ApprovalDocumentType; documentTitle: string
  projectId: string; projectName: string; amount: number; currency: string
  requestedBy: { id: string; name: string; email: string }
  totalSteps: number
  // When false (the default) the requester is never notified as an approver —
  // they can't decide their own request, so telling them it's "awaiting your
  // approval" is noise, and counting them as reachable hid stalled chains.
  allowSelfApproval?: boolean
}): Promise<number> {
  const excludeId = args.allowSelfApproval ? undefined : args.requestedBy.id
  // FIX (deep audit, notifications+search section): the role branch used
  // to build one shared `recipients` list via getMembersWithRole (capped
  // to 25 BEFORE preference filtering — see that function's fix comment),
  // then filter it per-channel afterward. Now getMembersWithRole applies
  // preference filtering before its own cap, so it's called once per
  // channel directly; the direct-user branch (at most one person, so the
  // cap never bites) still goes through the shared post-hoc filter below.
  let recipients: Array<{ id: string; name: string; email: string }> = []
  let inAppRecipients: Array<{ id: string; name: string; email: string }> = []
  let emailRecipients: Array<{ id: string; name: string; email: string }> = []
  if (args.step.approver_user_id) {
    // FIX (cron audit, section 17): this used to look the user up directly
    // in `users`, with no check that they're still an active member of
    // THIS workspace — a user removed or deactivated from the workspace
    // (but whose `users` row obviously still exists) kept getting emailed
    // to approve documents in a workspace they can no longer even open.
    // getMembersWithRole already checks workspace_members.status='active'
    // for the role-assignment path below; a specific-user assignment
    // needs the same check.
    const { data: m } = await service
      .from('workspace_members')
      .select('user_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.step.approver_user_id)
      .eq('status', 'active')
      .maybeSingle()
    if (m?.users && m.users.id !== excludeId) {
      recipients = [{ id: m.users.id, name: m.users.name, email: m.users.email }]
      // FIX (deep audit, RLS+permissions re-pass): same project-visibility
      // rule as the role-based branch below and as getMembersWithPermission
      // (audit round 4, finding #8) — a specifically-named approver isn't
      // exempt just because the assignment is individual rather than
      // role-based; if they hold VIEW_OWN_PROJECTS with no assignment to
      // THIS project, they'd get a 403 opening the document the
      // notification just emailed them the title/amount for.
      recipients = await filterToProjectAccess(
        service, args.projectId, recipients,
        new Map([[m.user_id, m.effective_permissions || {}]])
      )
    }
  } else if (args.step.approver_role_id) {
    inAppRecipients = await getMembersWithRole(service, args.workspaceId, args.step.approver_role_id, 25, args.projectId, 'approval_requested', 'in_app', excludeId)
    emailRecipients = await getMembersWithRole(service, args.workspaceId, args.step.approver_role_id, 25, args.projectId, 'approval_requested', 'email', excludeId)
  }
  if (args.step.approver_user_id) {
    // FIX (re-audit, notifications section): a single filterByNotificationPreference
    // call (defaulting to the `email_enabled` column) used to gate BOTH the
    // in-app insert below AND the email send — so an approver who muted
    // EMAIL for this event (the only toggle Settings exposes) never got a
    // bell notification either, even though `in_app_enabled` is a separate,
    // always-true-by-default column. Filter each channel against its own
    // column instead. (Role-branch recipients are already filtered per
    // channel above, before their own 25-cap — see getMembersWithRole.)
    inAppRecipients = await filterByNotificationPreference(service, args.workspaceId, 'approval_requested', recipients, 'in_app')
    emailRecipients = await filterByNotificationPreference(service, args.workspaceId, 'approval_requested', recipients, 'email')
  }
  const notifiedIds = new Set([...inAppRecipients.map(r => r.id), ...emailRecipients.map(r => r.id)])
  if (notifiedIds.size === 0) return 0

  // FIX (section-11/12 audit): document_type can be 'sow', 'co',
  // 'co_counter', or 'invoice' (see evaluateApprovalGate) — this used to
  // collapse anything that wasn't 'sow' straight to "Change order", so a
  // step approving acceptance of a client's negotiated counter-offer (or,
  // now, an invoice) read identically to one approving an ordinary
  // first-time CO send. An approver had no way to tell, from either the
  // bell notification or the email, which action they were actually being
  // asked to authorize.
  const documentLabel = documentLabelFor(args.documentType)
  const actionVerb = args.documentType === 'co_counter' ? 'accept the client\'s counter on' : 'send'

  if (inAppRecipients.length) {
    try {
      await insertNotificationRows(service, inAppRecipients.map(r => ({
        workspace_id: args.workspaceId,
        recipient_id: r.id,
        type:         'approval_requested',
        title:        `${documentLabel} awaiting your approval`,
        body:         `${args.requestedBy.name} wants to ${actionVerb} ${args.documentTitle} on ${args.projectName}.`,
        entity_type:  'approval_request',
        entity_id:    args.requestId,
      })))
    } catch { /* never let a notification failure break the approval flow */ }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  await Promise.all(emailRecipients.map(r =>
    sendApprovalRequestedEmail({
      to: r.email, approverName: r.name,
      documentLabel, documentTitle: args.documentTitle, projectName: args.projectName,
      amount: args.amount, currency: args.currency,
      stepNumber: args.step.step_order, totalSteps: args.totalSteps,
      requestedByName: args.requestedBy.name,
      isCounter: args.documentType === 'co_counter',
      url: `${appUrl}/approvals?highlight=${args.requestId}`,
    }).catch(e => console.error('approval requested email failed:', e))
  ))

  return notifiedIds.size
}

// FIX (Notifications & email fix round): the three in-app inserts in this file (step
// cancelled, approval requested, decision to requester) called `service.from('notifications')
// .insert(...)` inside a try/catch — but supabase-js returns `{ error }` instead of throwing,
// so a failed insert was never noticed. They now go through insertNotificationRows, which
// reads the error. (Recipients here are already filtered for project access and preference.)
async function notifyRequester(service: any, args: {
  workspaceId: string
  requester: { id: string; name: string; email: string }
  decision: 'approved' | 'rejected'
  documentLabel: string; docTitle: string; projectId: string; projectName: string
  decidedByName: string; note?: string; autoSent?: boolean; sendFailedReason?: string | null
  deliveryWarning?: string | null; isCounter?: boolean
  requestId: string
}) {
  // FIX (deep audit, notifications section): this was the one notification
  // in the whole approval pipeline that bypassed the preference system
  // entirely — no filterByNotificationPreference call on either channel,
  // and 'approval_approved'/'approval_rejected' weren't in EVENT_TYPES or
  // IN_APP_ONLY_EVENT_TYPES (app/api/notifications/preferences/route.ts),
  // so there was no toggle for it and PATCH would 400 if a client tried.
  // Both decisions notify the same person (the requester) about the same
  // kind of event — the outcome of their own request — so they share one
  // preference key ('approval_decision') rather than doubling the Settings
  // list with two near-identical rows.
  const [inAppOn] = await filterByNotificationPreference(
    service, args.workspaceId, 'approval_decision', [args.requester], 'in_app'
  )
  const [emailOn] = await filterByNotificationPreference(
    service, args.workspaceId, 'approval_decision', [args.requester], 'email'
  )

  if (inAppOn) {
    try {
      await insertNotificationRows(service, [{
        workspace_id: args.workspaceId,
        recipient_id: args.requester.id,
        type:         `approval_${args.decision}`,
        title:        `${args.documentLabel} ${args.decision}`,
        // FIX (section-11 fix round, flagship finding): this used to say
        // the same "{name} approved {title}." whether or not the
        // auto-send afterward actually worked — a failure was completely
        // silent to the one person positioned to notice and act on it.
        // See migration 053 + the send_failed_at flag surfaced in
        // ApprovalsClient with a retry action.
        body: args.decision === 'approved' && args.sendFailedReason
          ? `${args.decidedByName} approved ${args.docTitle}, but it could not be sent automatically (${args.sendFailedReason}) — open it in Approvals to retry.`
          : args.decision === 'approved' && args.deliveryWarning
          ? `${args.decidedByName} approved ${args.docTitle} and it was sent, but the email to the client could not be delivered — open it in Approvals for the details.`
          : `${args.decidedByName} ${args.decision} ${args.docTitle}${args.autoSent ? ' — sent to client' : ''}.`,
        // FIX (fix round, section-11 finding): this used entity_type:
        // 'project' + entity_id: projectId, which NotificationBell's
        // entityHref() only ever routes to the bare Project Overview —
        // every OTHER document-event notification family (invoice_*,
        // guardian_*, co_*, sow_*) got a specific fix to deep-link past
        // that to the right tab, but 'approval_approved'/'approval_
        // rejected' never matched any of those startsWith() branches, so
        // it always fell through. notifyStepApprovers (the sibling
        // "awaiting your approval" notification, right above) already
        // uses entity_type: 'approval_request' + entity_id: requestId,
        // which resolves straight to `/approvals?highlight=<id>` — this
        // now matches that exactly, which is a better destination anyway:
        // the approvals detail modal shows the full decision (who, when,
        // notes on every step), a link straight to the document's own
        // tab, AND — for the send-failed case — the actual Retry send
        // button, none of which a bare project page ever had.
        entity_type:  'approval_request',
        entity_id:    args.requestId,
      }])
    } catch { /* non-fatal */ }
  }

  if (emailOn) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    try {
      await sendApprovalDecisionEmail({
        to: args.requester.email, requesterName: args.requester.name,
        decision: args.decision, documentLabel: args.documentLabel, documentTitle: args.docTitle,
        projectName: args.projectName, decidedByName: args.decidedByName, note: args.note,
        // FIX (fix round, section-11 finding): same fix as the in-app
        // notification above, and it closes a sharper bug for the
        // send-failed case specifically — the email body text says
        // "Open it in Approvals and retry", but the button underneath it
        // still pointed at the bare project page, not /approvals, so the
        // one channel most likely to reach someone who's stepped away
        // sent them somewhere that (per the dashboard/project-detail
        // fixes elsewhere in this round) showed no sign anything was
        // wrong. The button destination now matches what the text says.
        url: `${appUrl}/approvals?highlight=${args.requestId}`, autoSent: args.autoSent,
        sendFailedReason: args.sendFailedReason, deliveryWarning: args.deliveryWarning, isCounter: args.isCounter,
      })
    } catch (e) { console.error('approval decision email failed:', e) }
  }
}

// FIX (section-11 audit, pass 2 — feature gap): in-app heads-up to the
// requester that one step of a multi-step chain cleared and the request is now
// with the next approver. Gated under the same 'approval_decision' preference
// as the final decision notification; deliberately not emailed (informational).
async function notifyRequesterProgress(service: any, args: {
  workspaceId: string
  requester: { id: string; name: string; email: string }
  documentLabel: string; docTitle: string
  decidedByName: string; step: number; totalSteps: number; requestId: string
}) {
  try {
    const [inAppOn] = await filterByNotificationPreference(
      service, args.workspaceId, 'approval_decision', [args.requester], 'in_app'
    )
    if (!inAppOn) return
    await insertNotificationRows(service, [{
      workspace_id: args.workspaceId,
      recipient_id: args.requester.id,
      type:         'approval_step_approved',
      title:        `${args.documentLabel}: step ${args.step} of ${args.totalSteps} approved`,
      body:         `${args.decidedByName} approved step ${args.step} of ${args.totalSteps} for ${args.docTitle} — it's now with the next approver.`,
      entity_type:  'approval_request',
      entity_id:    args.requestId,
    }])
  } catch { /* non-fatal */ }
}
