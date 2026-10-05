// lib/documents/send-co.ts
// Same extraction as lib/documents/send-sow.ts, for change orders.
// See that file's header for why this exists as a standalone function.

import { liveCoSiblingMessage } from '@/lib/documents/co-live-sibling'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { sendCoEmail } from '@/lib/email/templates'
import { logAudit } from '@/lib/utils/audit'
import { assignDocumentNumber } from '@/lib/utils/document-number'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { isTerminalStatus } from '@/lib/utils/project-status'
import { parseStoredLineItems } from '@/lib/documents/co-totals'
import { coGateAmount } from '@/lib/approvals/gate-amount'
import { findSignedSow, SIGNED_SOW_LOOKUP_FAILED } from '@/lib/documents/signed-sow'

export type SendCoResult =
  | {
      ok: true; token: string; portalUrl: string; projectId: string; coTitle: string; documentNumber: string
      // Resend reports a rejected send by RESOLVING with an error — surfaced so the agency can
      // copy the link and send it by hand instead of assuming the client has it.
      emailSent: boolean; emailError?: string
    }
  | { ok: false; error: string; status: number }

export const DEFAULT_CO_EXPIRY_DAYS = 30
export const MAX_CO_EXPIRY_DAYS = 90

/**
 * A retainer-renewal CO must state how many months it extends the retainer — but only when the retainer HAS a
 * fixed end to extend. An open-ended retainer (retainer_duration_months NULL) has nothing to extend, so demanding
 * a term there forced a meaningless number that finalize-co then discarded with a "check by hand" error.
 */
export function renewalNeedsTerm(co: { is_retainer_renewal?: boolean | null; renewal_term_months?: number | null }, project: { type?: string | null; retainer_duration_months?: number | null } | null | undefined): boolean {
  return !!co.is_retainer_renewal && project?.type === 'retainer'
    && Number(project?.retainer_duration_months) > 0 && !co.renewal_term_months
}

/**
 * What must hold before a CO is put in front of a client. Shared by the send route (which runs it
 * before the approval gate) and sendCoDocument (the approval chain's auto-send calls that
 * directly, and used to skip every one of these checks).
 */
export function validateCoForSend(input: { total: unknown; lineItems: unknown; isCredit?: boolean }): string | null {
  const items: any[] = parseStoredLineItems(input.lineItems)
  if (items.length === 0) return 'Add at least one line item before sending this change order.'
  const total = Number(input.total)
  // A credit / descope CO is a reduction: its total is stored negative (migration 100).
  if (input.isCredit) {
    if (!Number.isFinite(total) || total >= 0) return 'This credit has no value — add line item amounts before sending.'
  } else if (!Number.isFinite(total) || total <= 0) return 'This change order has no value — add line item amounts before sending.'
  if (items.some(li => Math.abs(Number(li?.total) || 0) > 0 && !String(li?.description || '').trim()))
    return 'Every line item with a value needs a description.'
  return null
}

export async function sendCoDocument(service: any, params: {
  coId: string
  workspaceId: string
  actorId: string
  actorEmail: string
  actorName: string
  approvalRequestId?: string
  expiresInDays?: number
  /** The amount the approval chain signed off on (context.amount). When given, a CO that has since changed size is not sent. */
  approvedGateAmount?: number | null
}): Promise<SendCoResult> {
  const { coId, workspaceId, actorId, actorEmail, actorName, approvalRequestId } = params
  const requestedDays = Number(params.expiresInDays)
  const expiryDays = Number.isFinite(requestedDays) && requestedDays >= 1
    ? Math.min(Math.trunc(requestedDays), MAX_CO_EXPIRY_DAYS)
    : DEFAULT_CO_EXPIRY_DAYS

  const { data: co, error: coFetchErr } = await (service as any)
    .from('change_orders')
    // FIX (carried forward): 'currency' isn't a column on change_orders —
    // it lives on projects. Selecting it here makes PostgREST reject the
    // whole query (42703), which silently surfaces as "CO not found".
    .select(`id,title,status,note,total,line_items,version,document_number,root_co_id,project_id,is_retainer_renewal,renewal_term_months,is_credit,
      projects(id,name,status,currency,type,retainer_duration_months,client_id,deleted_at,
        clients(name,email,cc_emails),
        workspaces(id,agency_name,brand_colour))`)
    .eq('id', coId).eq('workspace_id', workspaceId).single()

  if (!co) {
    console.error('CO send: lookup failed', { coId, workspaceId, error: coFetchErr })
    return { ok: false, error: 'CO not found', status: 404 }
  }
  if (co.status !== 'draft') return { ok: false, error: 'Only draft COs can be sent', status: 400 }

  const project   = co.projects
  const client    = project?.clients
  const workspace = project?.workspaces

  // FIX (Projects & Dashboard deep audit, flagship finding): nothing in this
  // function — the ONE place that actually fires the client-facing send,
  // reached both from the route and from recordApprovalDecision()'s
  // auto-send on final approval — ever checked the project's own status.
  // Only "does a signed SOW exist" was enforced, which stays true forever
  // once a project completes. A CO drafted (or already sitting in an
  // approval chain) before completion could therefore still be sent to the
  // client well after the agency marked the project Complete or Archived —
  // an approver deciding on it days later would auto-send it with no
  // route-level check in the way at all. Checked here, not just in the
  // route, specifically so the auto-send path is covered too.
  if (project && isTerminalStatus(project.status)) {
    return {
      ok: false,
      error: `This project is ${project.status.toLowerCase()} — a change order can no longer be sent. Reopen the project first.`,
      status: 409,
    }
  }

  if (!client?.email) return { ok: false, error: 'Client email required', status: 400 }
  // A renewal that doesn't say how long it runs would replace the rate but leave the retainer ending on its
  // original date — refuse to send it.
  if (renewalNeedsTerm(co, project))
    return { ok: false, error: 'A retainer renewal needs its term — enter how many months it extends the retainer for.', status: 400 }
  if (project?.deleted_at) return { ok: false, error: 'This project has been deleted', status: 404 }

  const invalid = validateCoForSend({ total: co.total, lineItems: co.line_items, isCredit: !!co.is_credit })
  if (invalid) return { ok: false, error: invalid, status: 400 }

  // The approvers signed off on a specific amount. PATCH checks for a pending approval and then writes as two separate
  // statements, so an edit landing in the instant a send-for-approval was created (or a slow, reordered autosave) can change
  // the CO AFTER it was submitted - and the auto-send would then put an unapproved figure in front of the client. Refuse it;
  // the requester cancels the request and sends again at the real amount.
  if (params.approvedGateAmount != null && Number.isFinite(Number(params.approvedGateAmount))) {
    const current = Math.abs(coGateAmount(co, project))
    if (Math.abs(current - Math.abs(Number(params.approvedGateAmount))) > 0.005)
      return { ok: false, status: 409, error: 'This change order was edited after it was submitted for approval, so the approved amount no longer matches. Cancel this request and send it again for approval.' }
  }

  const sowLookup = await findSignedSow(service, co.project_id)
  if (!sowLookup.ok) return { ok: false, status: 500, error: SIGNED_SOW_LOOKUP_FAILED }
  if (!sowLookup.sow)
    return { ok: false, status: 409, error: 'This project has no signed SOW yet — a change order can only be sent once the original scope of work is signed.' }

  // One live version per change-order lineage (shared with the send route, which runs it before the approval gate).
  const siblingBlock = await liveCoSiblingMessage(service, { id: coId, root_co_id: co.root_co_id })
  if (siblingBlock) return { ok: false, status: 409, error: siblingBlock }

  // FIX (deep audit, section 14 — flagship finding): see
  // lib/utils/client-contacts.ts — CC the client's designated primary
  // contact, if any, alongside cc_emails instead of never consulting
  // client_contacts at all.
  const ccEmails = await withPrimaryContactCc(service, project.client_id, client.email, client.cc_emails, 'co')

  // jwt_secret lives in workspace_secrets now, not on workspaces itself —
  // see migration 013.
  const jwtSecret = await getWorkspaceJwtSecret(service, workspaceId)
  if (!jwtSecret) return { ok: false, error: 'Workspace signing secret not found', status: 500 }
  const secret    = new TextEncoder().encode(jwtSecret)
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
  const token     = await new SignJWT({
    coId,
    workspaceId,
    projectId:   project.id,
    clientEmail: client.email,
    action:      'respond',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresAt)
    .setJti(nanoid())
    .sign(secret)

  const now = new Date().toISOString()

  // Claim the send FIRST (compare-and-swap on status), and only then take a document number. The number used
  // to be assigned before the swap, so every request that lost the race (a double-click, or a manual send
  // racing the approval engine's auto-send) still burned one — leaving gaps in the sequence that
  // lib/utils/document-number.ts promises stays continuous for anything a client actually saw.
  // FIX (re-audit, race-condition finding): same missing CAS as send-sow.ts — see that file's comment.
  const { data: sent, error: claimErr } = await (service as any).from('change_orders').update({
    status:          'awaiting_response',
    sent_at:         now,
    token,
    expires_at:      expiresAt.toISOString(),
    updated_at:      now,
  }).eq('id', coId).eq('status', 'draft').select('id').maybeSingle()

  // A failed write is not a lost race: report it as the retryable failure it is.
  if (claimErr) {
    console.error('CO send: could not claim the send', claimErr.message)
    return { ok: false, error: 'Could not send this change order. Please try again.', status: 500 }
  }
  if (!sent) {
    return { ok: false, error: 'This change order was already sent by another action', status: 409 }
  }

  // Never re-assign if already numbered (a revision of a numbered draft keeps its number).
  let documentNumber: string
  try {
    documentNumber = co.document_number || await assignDocumentNumber(service, workspaceId, 'co')
    if (!co.document_number) {
      const { error: numErr } = await (service as any).from('change_orders')
        .update({ document_number: documentNumber }).eq('id', coId).eq('token', token)
      if (numErr) throw new Error(numErr.message)
    }
  } catch (e) {
    // Thrown, not returned — without this the approval chain's auto-send had no failure result to record,
    // leaving the request "approved" with nothing sent. The claim is released so the CO is a draft again
    // (nothing was emailed yet, and the token was never shown to anyone).
    console.error('CO send: could not assign a document number', e)
    await (service as any).from('change_orders').update({
      status: 'draft', sent_at: null, token: null, expires_at: null, updated_at: new Date().toISOString(),
    }).eq('id', coId).eq('status', 'awaiting_response').eq('token', token)
    return { ok: false, error: 'Could not assign a document number. Please try again.', status: 500 }
  }

  const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/co/${token}`
  const replyTo = await resolveReplyTo(service, workspaceId, actorEmail)
  const delivery = await checkedSend(() => sendCoEmail({
    to:          client.email,
    cc:          ccEmails,
    clientName:  client.name,
    agencyName:  workspace.agency_name,
    projectName: project.name,
    coTitle:     co.title,
    total:       co.total,
    currency:    project.currency || 'USD',
    portalUrl,
    brandColour: workspace.brand_colour,
    note:        co.note,
    isCredit:    !!co.is_credit,
    replyTo,
    log:         { workspaceId, kind: 'co.send', entityType: 'change_order', entityId: coId, projectId: project.id, actorId },
  }), 'CO send email')

  await logAudit(service, {
    workspaceId, actorId,
    actorEmail, actorName,
    eventType: 'co.sent', entityType: 'change_order',
    entityId: coId, entityName: co.title,
    metadata: {
      total: co.total, document_number: documentNumber,
      expires_in_days: expiryDays, email_delivered: delivery.ok,
      ...(delivery.ok ? {} : { email_error: delivery.error }),
      ...(approvalRequestId ? { auto_sent_via_approval: approvalRequestId } : {}),
    },
  })

  return {
    ok: true, token, portalUrl, projectId: project.id, coTitle: co.title, documentNumber,
    emailSent: delivery.ok, ...(delivery.ok ? {} : { emailError: delivery.error }),
  }
}
