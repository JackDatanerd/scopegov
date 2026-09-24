// lib/documents/send-co.ts
// Same extraction as lib/documents/send-sow.ts, for change orders.
// See that file's header for why this exists as a standalone function.

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
 * What must hold before a CO is put in front of a client. Shared by the send route (which runs it
 * before the approval gate) and sendCoDocument (the approval chain's auto-send calls that
 * directly, and used to skip every one of these checks).
 */
export function validateCoForSend(input: { total: unknown; lineItems: unknown }): string | null {
  const items: any[] = typeof input.lineItems === 'string' ? JSON.parse(input.lineItems) : (Array.isArray(input.lineItems) ? input.lineItems : [])
  if (items.length === 0) return 'Add at least one line item before sending this change order.'
  const total = Number(input.total)
  if (!Number.isFinite(total) || total <= 0) return 'This change order has no value — add line item amounts before sending.'
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
    .select(`id,title,status,note,total,line_items,version,document_number,root_co_id,project_id,is_retainer_renewal,renewal_term_months,
      projects(id,name,status,currency,type,client_id,deleted_at,
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
  if (co.is_retainer_renewal && project?.type === 'retainer' && !co.renewal_term_months)
    return { ok: false, error: 'A retainer renewal needs its term — enter how many months it extends the retainer for.', status: 400 }
  if (project?.deleted_at) return { ok: false, error: 'This project has been deleted', status: 404 }

  const invalid = validateCoForSend({ total: co.total, lineItems: co.line_items })
  if (invalid) return { ok: false, error: invalid, status: 400 }

  const { data: signedSow } = await (service as any)
    .from('sow_documents').select('id').eq('project_id', co.project_id).eq('status', 'signed').limit(1).maybeSingle()
  if (!signedSow)
    return { ok: false, status: 409, error: 'This project has no signed SOW yet — a change order can only be sent once the original scope of work is signed.' }

  // One live version per change-order lineage. Two live siblings (e.g. two revisions of the same
  // declined CO) could both be accepted — billing the same extra work twice.
  const rootId = co.root_co_id || co.id
  const { data: liveSiblings } = await (service as any)
    .from('change_orders').select('id, version, status')
    .or(`id.eq.${rootId},root_co_id.eq.${rootId}`).neq('id', coId)
    .in('status', ['awaiting_response', 'stalled', 'countered', 'awaiting_countersignature', 'accepted']).limit(1)
  if (liveSiblings && liveSiblings.length > 0)
    return { ok: false, status: 409, error: `Version ${liveSiblings[0].version} of this change order is still open (${String(liveSiblings[0].status).replace(/_/g, ' ')}). Withdraw or close it before sending another version.` }

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

  // Phase 0: assign sequential document number at send (not on draft
  // creation). Never re-assign if already numbered.
  let documentNumber: string
  try {
    documentNumber = co.document_number || await assignDocumentNumber(service, workspaceId, 'co')
  } catch (e) {
    // Thrown, not returned — without this the approval chain's auto-send had no failure result to
    // record, leaving the request "approved" with nothing sent.
    console.error('CO send: could not assign a document number', e)
    return { ok: false, error: 'Could not assign a document number. Please try again.', status: 500 }
  }

  // FIX (re-audit, race-condition finding): same missing CAS as
  // send-sow.ts — see that file's comment for the full rationale. Two
  // racing callers (manual Send + approval-engine auto-send, or a
  // double-click) could otherwise both pass the earlier `status !== 'draft'`
  // read and both send, burning two document numbers and emailing the
  // client two different tokens.
  const { data: sent } = await (service as any).from('change_orders').update({
    status:          'awaiting_response',
    sent_at:         now,
    token,
    expires_at:      expiresAt.toISOString(),
    document_number: documentNumber,
    updated_at:      now,
  }).eq('id', coId).eq('status', 'draft').select('id').maybeSingle()

  if (!sent) {
    return { ok: false, error: 'This change order was already sent by another action', status: 409 }
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
