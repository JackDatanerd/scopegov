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

export type SendSowResult =
  | { ok: true; token: string; portalUrl: string; projectId: string; projectName: string; documentNumber: string }
  | { ok: false; error: string; status: number }

export async function sendSowDocument(service: any, params: {
  sowId: string
  workspaceId: string
  actorId: string
  actorEmail: string
  actorName: string
  // Present when this send was triggered by an approval chain clearing,
  // rather than a direct user click — carried into the audit metadata.
  approvalRequestId?: string
}): Promise<SendSowResult> {
  const { sowId, workspaceId, actorId, actorEmail, actorName, approvalRequestId } = params

  const { data: sow } = await (service as any)
    .from('sow_documents')
    .select(`id, version, status, project_id, document_number,
      projects(id, name, disc, contract_value, currency, client_id,
        clients(name, email, cc_emails),
        workspaces(id, agency_name, brand_colour, logo_storage_path))`)
    .eq('id', sowId).eq('workspace_id', workspaceId).single()

  if (!sow) return { ok: false, error: 'SOW not found', status: 404 }
  if (sow.status !== 'draft') return { ok: false, error: 'Only draft SOWs can be sent', status: 400 }

  const project   = sow.projects
  const client    = project?.clients
  const workspace = project?.workspaces

  if (!client?.email) return { ok: false, error: 'Client email is required to send SOW', status: 400 }

  // jwt_secret lives in workspace_secrets now, not on workspaces itself —
  // see migration 013.
  const jwtSecret = await getWorkspaceJwtSecret(service, workspaceId)
  if (!jwtSecret) return { ok: false, error: 'Workspace signing secret not found', status: 500 }
  const secret    = new TextEncoder().encode(jwtSecret)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
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
  const documentNumber = sow.document_number || await assignDocumentNumber(service, workspaceId, 'sow')

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

  await (service as any).from('projects').update({
    status:     'Awaiting Signature',
    updated_at: now,
  }).eq('id', project.id)

  const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/sow/${token}`
  try {
    await sendSowEmail({
      to:            client.email,
      cc:            client.cc_emails || [],
      clientName:    client.name,
      agencyName:    workspace.agency_name,
      projectName:   project.name + (project.disc ? ` — ${project.disc}` : ''),
      contractValue: project.contract_value,
      currency:      project.currency,
      portalUrl,
      brandColour:   workspace.brand_colour,
      expiresAt:     expiresAt.toISOString(),
    })
  } catch (emailErr) {
    console.error('SOW send email failed:', emailErr)
    // Email failure is non-fatal for the operation — SOW is still sent
  }

  await logAudit(service, {
    workspaceId,
    actorId, actorEmail, actorName,
    eventType: 'sow.sent', entityType: 'sow',
    entityId: sowId, entityName: project.name,
    metadata: {
      version: sow.version, client_email: client.email, document_number: documentNumber,
      ...(approvalRequestId ? { auto_sent_via_approval: approvalRequestId } : {}),
    },
  })

  return { ok: true, token, portalUrl, projectId: project.id, projectName: project.name, documentNumber }
}
