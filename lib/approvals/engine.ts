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
import { getMembersWithRole, filterByNotificationPreference, filterToProjectAccess } from '@/lib/utils/permissions-query'
import { sendApprovalRequestedEmail, sendApprovalDecisionEmail } from '@/lib/email/templates'
import { sendSowDocument } from '@/lib/documents/send-sow'
import { sendCoDocument } from '@/lib/documents/send-co'
import { sendInvoiceDocument } from '@/lib/documents/send-invoice'
import { acceptCoCounter } from '@/lib/documents/accept-co-counter'
import { hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
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
    .eq('document_type', workflowLookupType(documentType))
    .eq('is_active', true)
    // FIX (section-11 audit, pass 2): no explicit order — two active
    // workflows with the SAME threshold_amount resolved to whichever
    // Postgres happened to return first, which SQL doesn't guarantee
    // without an ORDER BY. Ordering by id gives a stable, at-least-
    // deterministic tie-break (doesn't fix the underlying "which rule
    // governs" ambiguity for an admin who's duplicated a threshold, but
    // at least the same workflow wins every time rather than varying
    // run to run).
    .order('id', { ascending: true })

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

  // FIX (section-11 audit): this insert had no error check at all, unlike
  // the identical approval_workflow_steps insert in the workflow-creation
  // routes. A partial failure here (e.g. a transient DB error) left a
  // 'pending' approval_requests row with total_steps > 0 but zero real
  // approval_steps rows — notifyStepApprovers() below still fires because
  // it reads from the workflow's template `steps`, not from what actually
  // got inserted, so an approver would be told to decide on something
  // recordApprovalDecision() can never find (it looks up approval_steps by
  // request_id + step_order and would come back empty), returning a
  // misleading "already decided" error with no way for anyone to tell what
  // actually went wrong. Fail closed here the same way the request insert
  // above does: roll back the orphaned request and halt the send.
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

  // FIX (section-11 audit, flagship finding): nothing anywhere in this
  // gate/decision path ever checked whether the person deciding is the
  // same person who requested the send in the first place. Send
  // permission (SEND_SOW/SEND_CHANGE_ORDERS/SEND_INVOICES) and approval
  // permission (APPROVE_DOCUMENTS) are both commonly held by the same
  // role (an agency owner/admin), so if that role is also the workflow's
  // configured approver, the requester could send their own document for
  // approval and then approve it themselves — defeating the entire point
  // of a governance/approval product. This blocks a decision (either
  // direction) by the same user who triggered the request that created
  // it, regardless of how they qualify as an eligible approver for the
  // step (named or via role).
  if (request.requested_by === params.actor.id)
    return { ok: false, error: 'You requested this — it needs to be decided by someone else', status: 403 }

  // FIX (section-11 audit, flagship finding): everywhere else in this file
  // that touches an approver — notifyStepApprovers' role branch (via
  // getMembersWithRole's projectId param) and its direct-user branch (via
  // filterToProjectAccess), both with explicit comments reasoning about
  // exactly this — scopes the approver to whoever can actually SEE the
  // project the document lives on. That principle was only ever wired
  // into the notification layer (who gets emailed), never into this, the
  // actual authorization boundary (who's allowed to click Approve). A
  // member on VIEW_OWN_PROJECTS with no assignment to this project, but
  // who happens to hold the assigned role (or is the named approver),
  // could approve/reject — and thereby trigger a real send to the client
  // — for a project they have no other visibility into. canReadProject
  // is the same primitive every other document-mutating route in the app
  // already gates writes on; the decision path was the one place that
  // never got it.
  if (!(await canReadProject(service, params.actor, request.project_id)))
    return { ok: false, error: 'You do not have access to this project', status: 403 }

  const now = new Date().toISOString()
  // FIX (section-11 audit): same collapsing fix as notifyStepApprovers
  // below — a decided 'co_counter' request (approving/rejecting
  // acceptance of a client's negotiated counter-offer) used to read as a
  // plain "Change order" decision, indistinguishable from an ordinary CO
  // send decision, in both the requester's notification and the audit
  // trail's implicit framing.
  const documentLabel = documentLabelFor(request.document_type)
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

    // FIX (section-11 audit): only the just-decided step was ever touched
    // here — every step AFTER it (inserted 'pending' at request creation,
    // same as the decided one was) stayed 'pending' forever, since the
    // chain never advances past a rejection. cancelApprovalRequest()
    // already does the equivalent cleanup for a cancelled request
    // (marking every still-pending step 'skipped'); a rejected request
    // needs the same so its own detail view doesn't render un-reached
    // steps as "Awaiting decision" under a request that's already dead.
    await service.from('approval_steps').update({ status: 'skipped' })
      .eq('request_id', request.id).eq('status', 'pending')

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
      entityType: entityTypeFor(request.document_type),
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
        projectId: request.project_id, projectName,
        amount: request.context?.amount || 0, currency: request.context?.currency || 'USD',
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
    entityType: entityTypeFor(request.document_type),
    entityId: request.document_id, entityName: docTitle,
    metadata: { approval_request_id: request.id, step: step.step_order, note: params.note || null },
  })

  let autoSent = false
  let sendFailedReason: string | null = null
  if (requester) {
    const sendParams = {
      workspaceId: params.actor.workspaceId,
      actorId: requester.id, actorEmail: requester.email, actorName: requester.name,
      approvalRequestId: request.id,
    }
    // FIX (section-11 audit): 'co_counter' needs its own auto-finalize —
    // it's not a fresh send, it's accepting an already-negotiated
    // counter-offer. Routing it through sendCoDocument (which CASes on
    // status:'draft') would silently no-op, since a countered CO's
    // status is 'countered', not 'draft' — the approval would record as
    // 'approved' while the client never actually got a countersignature
    // request, stranding the CO indefinitely.
    const result = request.document_type === 'sow'
      ? await sendSowDocument(service, { sowId: request.document_id, ...sendParams })
      : request.document_type === 'co_counter'
      ? await acceptCoCounter(service, { coId: request.document_id, ...sendParams })
      : request.document_type === 'invoice'
      ? await sendInvoiceDocument(service, { invoiceId: request.document_id, ...sendParams })
      : await sendCoDocument(service, { coId: request.document_id, ...sendParams })
    autoSent = result.ok
    if (!result.ok) {
      sendFailedReason = result.error
      console.error('Auto-send after final approval failed:', result.error)
      // FIX (section-11 fix round, flagship finding): see migration 053.
      // Recorded on the request itself (still correctly 'approved' — the
      // CHAIN approved; only the mechanical send after it failed) so it's
      // discoverable in the UI and retryable without re-running the whole
      // gate. Best-effort: if this write itself fails, the console.error
      // above is still the fallback trail — never let a logging failure
      // block the approval outcome already recorded above.
      await service.from('approval_requests').update({
        send_failed_at: now, send_failed_reason: sendFailedReason,
      }).eq('id', request.id).then(null, (e: unknown) => console.error('Failed to record send_failed_at:', e))
    }
  }

  if (requester) {
    await notifyRequester(service, {
      workspaceId: params.actor.workspaceId, requester, decision: 'approved',
      documentLabel, docTitle, projectId: request.project_id, projectName,
      decidedByName: params.actor.name, note: params.note, autoSent, sendFailedReason, requestId: request.id,
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
  const { data: request } = await service
    .from('approval_requests')
    .select('id, project_id, current_step, context, status')
    .eq('document_type', params.documentType)
    .eq('document_id', params.documentId)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
    .maybeSingle()
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
        await service.from('notifications').insert(stepRecipients.map(r => ({
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
// FIX (cron audit, section 17 — flagship finding): this used to return
// `true` unconditionally after calling notifyStepApprovers, which itself
// silently no-ops when it ends up with zero recipients (approver_role_id
// has no active holder, or — see the fix in notifyStepApprovers below —
// approver_user_id points at someone no longer an active member of this
// workspace). approval-stall/route.ts trusts this return value to decide
// whether to reset the stall clock and log 'approval.reminder_sent' — so
// a broken approver assignment was resetting the clock and recording a
// reminder that reached nobody, every 2 days, forever. The request just
// sat there invisibly: exactly the silent-stall failure mode this whole
// product exists to catch, reproduced inside the mechanism built to catch
// it. Returning a real tri-state lets the cron tell "reminded" apart from
// "nobody to remind" and act on that instead of assuming success.
export async function sendApprovalReminder(
  service: any, requestId: string
): Promise<'sent' | 'no_recipients' | 'not_found'> {
  const { data: request } = await service
    .from('approval_requests')
    .select('id, workspace_id, document_type, current_step, total_steps, context, requested_by, project_id')
    .eq('id', requestId).eq('status', 'pending').single()
  if (!request) return 'not_found'

  const { data: step } = await service
    .from('approval_steps')
    .select('step_order, approver_role_id, approver_user_id')
    .eq('request_id', requestId).eq('step_order', request.current_step).single()
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
  })
  return notifiedCount > 0 ? 'sent' : 'no_recipients'
}

// ── RETRY (send_failed_at) ──────────────────────────────────────
// FIX (section-11 fix round, flagship finding): see migration 053 and the
// send_failed_at/send_failed_reason write in recordApprovalDecision above.
// This is the recovery path for a request that finished approving but
// whose auto-send afterward failed — it re-attempts ONLY the mechanical
// send, against a request that's already 'approved'. It deliberately does
// NOT go anywhere near evaluateApprovalGate: re-running the gate would
// create a brand-new approval_request and re-notify every approver to
// decide something they've already decided, which is exactly the bad
// "recovery path" this whole fix exists to replace.
export async function retryFailedSend(service: any, params: {
  requestId: string
  workspaceId: string
  actor: { id: string; email: string; name: string }
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: request } = await service
    .from('approval_requests')
    .select('id, document_type, document_id, project_id, context, status, send_failed_at')
    .eq('id', params.requestId).eq('workspace_id', params.workspaceId).single()

  if (!request) return { ok: false, error: 'Approval request not found' }
  if (request.status !== 'approved' || !request.send_failed_at)
    return { ok: false, error: 'This request has nothing to retry' }

  const sendParams = {
    workspaceId: params.workspaceId,
    actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
    approvalRequestId: request.id,
  }
  const result = request.document_type === 'sow'
    ? await sendSowDocument(service, { sowId: request.document_id, ...sendParams })
    : request.document_type === 'co_counter'
    ? await acceptCoCounter(service, { coId: request.document_id, ...sendParams })
    : request.document_type === 'invoice'
    ? await sendInvoiceDocument(service, { invoiceId: request.document_id, ...sendParams })
    : await sendCoDocument(service, { coId: request.document_id, ...sendParams })

  const now = new Date().toISOString()
  if (result.ok) {
    await service.from('approval_requests').update({
      send_failed_at: null, send_failed_reason: null, updated_at: now,
    }).eq('id', request.id)
    await logAudit(service, {
      workspaceId: params.workspaceId,
      actorId: params.actor.id, actorEmail: params.actor.email, actorName: params.actor.name,
      eventType: 'approval.send_retried', entityType: entityTypeFor(request.document_type),
      entityId: request.document_id, entityName: request.context?.title || '',
      metadata: { approval_request_id: request.id },
    })
    return { ok: true }
  }

  // Still failing (e.g. the client's email is still missing) — refresh the
  // reason shown in the UI so it reflects whatever's actually wrong now,
  // rather than the original failure from however long ago.
  await service.from('approval_requests').update({
    send_failed_reason: result.error, updated_at: now,
  }).eq('id', request.id)
  return { ok: false, error: result.error }
}

// ── LOOKUP ───────────────────────────────────────────────────────
// FIX (fix round, section-11 flagship finding): every caller of this
// function is an edit-lock — "don't let the document change while an
// approval concern is outstanding." That was only ever true for
// status='pending'. A request that fully approved but then failed to
// auto-send (status='approved', send_failed_at set — see migration 053)
// is just as much an outstanding concern: the document is sitting in a
// "the client is about to receive exactly this" state, waiting on a
// retry, and nothing stopped an edit from changing it out from under
// that already-granted approval in the meantime — the eventual retry
// would ship whatever the document looks like *now*, with no relation to
// what was actually approved, and with none of the sending route's own
// business-rule validation re-run (that validation only ever runs once,
// at the original send attempt). Broadened to match either state so the
// edit-lock actually covers the full window a document can be "spoken
// for" by an approval decision.
export async function getPendingApprovalForDocument(
  service: any, documentType: ApprovalDocumentType, documentId: string
): Promise<{ id: string; current_step: number; total_steps: number } | null> {
  const { data } = await service
    .from('approval_requests')
    .select('id, current_step, total_steps')
    .eq('document_type', documentType)
    .eq('document_id', documentId)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
    .maybeSingle()
  return data || null
}

// ── NOTIFICATION HELPERS ─────────────────────────────────────────
async function notifyStepApprovers(service: any, args: {
  workspaceId: string; requestId: string; step: WorkflowStepRow
  documentType: ApprovalDocumentType; documentTitle: string
  projectId: string; projectName: string; amount: number; currency: string
  requestedBy: { id: string; name: string; email: string }
  totalSteps: number
}): Promise<number> {
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
    if (m?.users) {
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
    inAppRecipients = await getMembersWithRole(service, args.workspaceId, args.step.approver_role_id, 25, args.projectId, 'approval_requested', 'in_app')
    emailRecipients = await getMembersWithRole(service, args.workspaceId, args.step.approver_role_id, 25, args.projectId, 'approval_requested', 'email')
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
      await service.from('notifications').insert(inAppRecipients.map(r => ({
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
      url: `${appUrl}/approvals?highlight=${args.requestId}`,
    }).catch(e => console.error('approval requested email failed:', e))
  ))

  return notifiedIds.size
}

async function notifyRequester(service: any, args: {
  workspaceId: string
  requester: { id: string; name: string; email: string }
  decision: 'approved' | 'rejected'
  documentLabel: string; docTitle: string; projectId: string; projectName: string
  decidedByName: string; note?: string; autoSent?: boolean; sendFailedReason?: string | null
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
      await service.from('notifications').insert({
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
      })
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
        sendFailedReason: args.sendFailedReason,
      })
    } catch (e) { console.error('approval decision email failed:', e) }
  }
}
