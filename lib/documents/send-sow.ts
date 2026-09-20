// lib/documents/send-sow.ts
//
// The actual mechanics of sending a SOW to a client (assign its document
// number, issue the document JWT, flip status, email the client, write the
// audit row). Extracted out of app/api/sow/[id]/send/route.ts so it can be
// called from two places with identical behaviour:
//   1. The route itself, when no approval gate applies.
//   2. lib/approvals/engine.ts, when a workflow's final step approves and
//      the document should go out immediately (see engine.ts header for
//      why auto-send-on-approval was the chosen UX).
//
// This file intentionally contains ONLY the send mechanics — no permission
// checks, no approval-gate logic. Callers are responsible for both.

import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { sendSowEmail } from '@/lib/email/templates'
import { logAudit } from '@/lib/utils/audit'
import { assignDocumentNumber } from '@/lib/utils/document-number'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { validateSowForSend } from '@/lib/sow/validate-send'
import { checkedSend } from '@/lib/email/delivery'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { isTerminalStatus } from '@/lib/utils/project-status'

export type SendSowResult =
  | {
      ok: true; token: string; portalUrl: string; projectId: string; projectName: string; documentNumber: string
      // The Resend SDK reports rejected sends by RESOLVING with an error, never throwing, so a
      // "successful" send used to be reported even when nothing left the building. Callers
      // surface this (and the portalUrl) so the agency can copy the link by hand.
      emailSent: boolean; emailError?: string
    }
  | { ok: false; error: string; status: number; warnings?: string[] }

export const DEFAULT_SOW_EXPIRY_DAYS = 30
export const MAX_SOW_EXPIRY_DAYS = 90

export async function sendSowDocument(service: any, params: {
  sowId: string
  workspaceId: string
  actorId: string
  actorEmail: string
  actorName: string
  // Present when this send was triggered by an approval chain clearing,
  // rather than a direct user click — carried into the audit metadata.
  approvalRequestId?: string
  // Interactive sends pass true so a human sees soft warnings (e.g. Payment Terms text that
  // doesn't state the contract value) before the document goes out; the unattended
  // approval-chain auto-send leaves it off and only hard errors block.
  enforceWarnings?: boolean
  acknowledgeWarnings?: boolean
  expiresInDays?: number
}): Promise<SendSowResult> {
  const { sowId, workspaceId, actorId, actorEmail, actorName, approvalRequestId } = params
  const requestedDays = Number(params.expiresInDays)
  const expiryDays = Number.isFinite(requestedDays) && requestedDays >= 1
    ? Math.min(Math.trunc(requestedDays), MAX_SOW_EXPIRY_DAYS)
    : DEFAULT_SOW_EXPIRY_DAYS

  const { data: sow } = await (service as any)
    .from('sow_documents')
    .select(`id, version, status, project_id, document_number, sections, metadata,
      projects(id, name, disc, status, contract_value, currency, client_id, deleted_at,
        clients(name, email, cc_emails),
        workspaces(id, agency_name, brand_colour, logo_storage_path))`)
    .eq('id', sowId).eq('workspace_id', workspaceId).single()

  if (!sow) return { ok: false, error: 'SOW not found', status: 404 }
  if (sow.status !== 'draft') return { ok: false, error: 'Only draft SOWs can be sent', status: 400 }

  const project   = sow.projects
  const client    = project?.clients
  const workspace = project?.workspaces

  // FIX (Projects & Dashboard deep audit): same terminal-status check added
  // to send-co.ts — a project that's Complete or Archived has, by
  // definition, already had its scope of work settled; sending a fresh SOW
  // to it (a stale draft left over from before completion, or one auto-
  // sent by an approval chain that clears after the fact) makes no sense
  // and would generate a real client-facing signing request against a
  // project the agency considers closed out.
  if (project && isTerminalStatus(project.status)) {
    return {
      ok: false,
      error: `This project is ${project.status.toLowerCase()} — a SOW can no longer be sent. Reopen the project first.`,
      status: 409,
    }
  }

  if (!client?.email) return { ok: false, error: 'Client email is required to send SOW', status: 400 }
  if (project?.deleted_at) return { ok: false, error: 'This project has been deleted', status: 404 }

  // Same validation the interactive route runs — kept HERE as well because the approval
  // chain's auto-send calls this function directly, possibly days after the request was
  // made, and the contract value or schedule can have changed in between.
  const validation = validateSowForSend({ sections: sow.sections, metadata: sow.metadata, contractValue: project.contract_value })
  if (validation.errors.length > 0)
    return { ok: false, error: validation.errors[0], status: 400 }
  if (params.enforceWarnings && !params.acknowledgeWarnings && validation.warnings.length > 0)
    return { ok: false, error: validation.warnings[0], status: 409, warnings: validation.warnings }

  // One live SOW per project: refuse while another version is out for signature or signed.
  const { data: liveOthers } = await (service as any)
    .from('sow_documents').select('id, status, version')
    .eq('project_id', project.id).neq('id', sowId).in('status', ['awaiting_signature', 'signed']).limit(1)
  if (liveOthers && liveOthers.length > 0) {
    return {
      ok: false, status: 409,
      error: liveOthers[0].status === 'signed'
        ? 'This project already has a signed SOW. Use a change order to change the agreed scope.'
        : `SOW v${liveOthers[0].version} for this project is still out for signature. Withdraw it before sending another version.`,
    }
  }

  // FIX (deep audit, section 14 — flagship finding): see
  // lib/utils/client-contacts.ts — CC the client's designated primary
  // contact, if any, alongside cc_emails instead of never consulting
  // client_contacts at all.
  const ccEmails = await withPrimaryContactCc(service, project.client_id, client.email, client.cc_emails)

  // jwt_secret lives in workspace_secrets now, not on workspaces itself —
  // see migration 013.
  const jwtSecret = await getWorkspaceJwtSecret(service, workspaceId)
  if (!jwtSecret) return { ok: false, error: 'Workspace signing secret not found', status: 500 }
  const secret    = new TextEncoder().encode(jwtSecret)
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
  const token     = await new SignJWT({
    sowId,
    workspaceId,
    projectId:   project.id,
    clientEmail: client.email,
    action:      'sign',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresAt)
    .setJti(nanoid())
    .sign(secret)

  const now = new Date().toISOString()

  // Phase 0: assign the SOW its sequential document number now — send is
  // the point of no return for numbering (a draft that never gets sent
  // shouldn't burn a number). Never re-assign if one already exists.
  let documentNumber: string
  try {
    documentNumber = sow.document_number || await assignDocumentNumber(service, workspaceId, 'sow')
  } catch (e) {
    // Thrown (not returned) — without this the approval-chain caller had no result to record
    // as a failed send, leaving the request "approved" with nothing sent and no retry path.
    console.error('SOW send: could not assign a document number', e)
    return { ok: false, error: 'Could not assign a document number. Please try again.', status: 500 }
  }

  // Update SOW: draft → awaiting_signature. Note: 'sent' is NOT a status (spec §1.3)
  // FIX (re-audit, race-condition finding): every client-portal action
  // (sign/decline/counter/accept/countersign) already guards its status
  // transition with a CAS (.eq('status', <expected>)) to survive a
  // double-click or two near-simultaneous triggers — this send path,
  // called from both the manual "Send" button and the approval engine's
  // auto-send-on-final-approval, never got the same guard. Two racing
  // callers could both pass the earlier `status !== 'draft'` read and both
  // reach here, burning two document numbers and emailing the client two
  // different tokens (only the last write's token stays valid — the first
  // email's link silently 404s). Guard the transition itself and bail if
  // another caller already won the race.
  const { data: sent } = await (service as any).from('sow_documents').update({
    status:          'awaiting_signature',
    sent_at:         now,
    token,
    expires_at:      expiresAt.toISOString(),
    document_number: documentNumber,
    updated_at:      now,
  }).eq('id', sowId).eq('status', 'draft').select('id').maybeSingle()

  if (!sent) {
    return { ok: false, error: 'This SOW was already sent by another action', status: 409 }
  }

  // Only move projects that are still pre-signature. An Active/Complete/Archived project
  // must not be dragged back to "Awaiting Signature" by sending another version.
  await (service as any).from('projects').update({
    status:     'Awaiting Signature',
    updated_at: now,
  }).eq('id', project.id).in('status', ['Draft', 'Intake', 'Changes Requested', 'Stalled', 'Awaiting Signature'])

  const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/sow/${token}`
  const replyTo = await resolveReplyTo(service, workspaceId, actorEmail)
  const delivery = await checkedSend(() => sendSowEmail({
    to:            client.email,
    cc:            ccEmails,
    clientName:    client.name,
    agencyName:    workspace.agency_name,
    projectName:   project.name + (project.disc ? ` — ${project.disc}` : ''),
    contractValue: project.contract_value,
    currency:      project.currency,
    portalUrl,
    brandColour:   workspace.brand_colour,
    expiresAt:     expiresAt.toISOString(),
    replyTo,
    log:           { workspaceId, kind: 'sow.send', entityType: 'sow', entityId: sowId, projectId: project.id, actorId },
  }), 'SOW send email')

  await logAudit(service, {
    workspaceId,
    actorId, actorEmail, actorName,
    eventType: 'sow.sent', entityType: 'sow',
    entityId: sowId, entityName: project.name,
    metadata: {
      version: sow.version, client_email: client.email, document_number: documentNumber,
      expires_in_days: expiryDays, email_delivered: delivery.ok,
      ...(delivery.ok ? {} : { email_error: delivery.error }),
      ...(approvalRequestId ? { auto_sent_via_approval: approvalRequestId } : {}),
    },
  })

  return {
    ok: true, token, portalUrl, projectId: project.id, projectName: project.name, documentNumber,
    emailSent: delivery.ok, ...(delivery.ok ? {} : { emailError: delivery.error }),
  }
}
