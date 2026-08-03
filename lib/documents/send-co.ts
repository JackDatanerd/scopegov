// lib/documents/send-co.ts
// Same extraction as lib/documents/send-sow.ts, for change orders.
// See that file's header for why this exists as a standalone function.

import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { sendCoEmail } from '@/lib/email/templates'
import { logAudit } from '@/lib/utils/audit'
import { assignDocumentNumber } from '@/lib/utils/document-number'

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
      projects(id,name,currency,client_id,
        clients(name,email,cc_emails),
        workspaces(id,agency_name,brand_colour,jwt_secret))`)
    .eq('id', coId).eq('workspace_id', workspaceId).single()

  if (!co) {
    console.error('CO send: lookup failed', { coId, workspaceId, error: coFetchErr })
    return { ok: false, error: 'CO not found', status: 404 }
  }
  if (co.status !== 'draft') return { ok: false, error: 'Only draft COs can be sent', status: 400 }

  const project   = co.projects
  const client    = project?.clients
  const workspace = project?.workspaces

  if (!client?.email) return { ok: false, error: 'Client email required', status: 400 }

  const secret    = new TextEncoder().encode(workspace.jwt_secret)
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

  await (service as any).from('change_orders').update({
    status:          'awaiting_response',
    sent_at:         now,
    token,
    expires_at:      expiresAt.toISOString(),
    document_number: documentNumber,
    updated_at:      now,
  }).eq('id', coId)

  const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/co/${token}`
  try {
    await sendCoEmail({
      to:          client.email,
      cc:          client.cc_emails || [],
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
