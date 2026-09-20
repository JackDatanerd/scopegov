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
import { isTerminalStatus } from '@/lib/utils/project-status'

export type SendCoResult =
  | { ok: true; token: string; portalUrl: string; projectId: string; coTitle: string; documentNumber: string }
  | { ok: false; error: string; status: number }

export async function sendCoDocument(service: any, params: {
  coId: string
  workspaceId: string
  actorId: string
  actorEmail: string
  actorName: string
  approvalRequestId?: string
}): Promise<SendCoResult> {
  const { coId, workspaceId, actorId, actorEmail, actorName, approvalRequestId } = params

  const { data: co, error: coFetchErr } = await (service as any)
    .from('change_orders')
    // FIX (carried forward): 'currency' isn't a column on change_orders —
    // it lives on projects. Selecting it here makes PostgREST reject the
    // whole query (42703), which silently surfaces as "CO not found".
    .select(`id,title,status,note,total,version,document_number,
      projects(id,name,status,currency,client_id,
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
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
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
  const documentNumber = co.document_number || await assignDocumentNumber(service, workspaceId, 'co')

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
  try {
    await sendCoEmail({
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
    })
  } catch (e) { console.error('CO email failed:', e) }

  await logAudit(service, {
    workspaceId, actorId,
    actorEmail, actorName,
    eventType: 'co.sent', entityType: 'change_order',
    entityId: coId, entityName: co.title,
    metadata: {
      total: co.total, document_number: documentNumber,
      ...(approvalRequestId ? { auto_sent_via_approval: approvalRequestId } : {}),
    },
  })

  return { ok: true, token, portalUrl, projectId: project.id, coTitle: co.title, documentNumber }
}
