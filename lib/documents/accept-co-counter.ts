// lib/documents/accept-co-counter.ts
//
// FIX (section-11 audit, headline finding): extracted out of
// app/api/co/[id]/accept-counter/route.ts, same extraction pattern as
// send-sow.ts/send-co.ts, for the same reason — this now needs to run
// from two places: directly from the route when the negotiated amount
// doesn't require approval, and from lib/approvals/engine.ts's
// recordApprovalDecision() on final approval when it does. Before this
// fix, accepting a client's counter-offer never re-checked the approval
// gate at all — a CO that sent fine at $5,000 under a "$10k+ needs
// approval" workflow could have its counter-offer accepted at $75,000
// with zero sign-off, since the only gate check in the whole CO
// lifecycle happened at the original send, not at counter-acceptance.

import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { logAudit } from '@/lib/utils/audit'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { sendCoCountersignatureRequestEmail } from '@/lib/email/templates'
import { rescaleLineItemsToTotal } from '@/lib/utils/rescale-line-items'

export type AcceptCoCounterResult =
  | { ok: true; awaitingCountersignature: true }
  | { ok: false; error: string; status: number }

export async function acceptCoCounter(service: any, params: {
  coId: string
  workspaceId: string
  actorId: string
  actorEmail: string
  actorName: string
  approvalRequestId?: string
}): Promise<AcceptCoCounterResult> {
  const { coId, workspaceId, actorId, actorEmail, actorName, approvalRequestId } = params

  const { data: co } = await (service as any)
    .from('change_orders')
    .select(`id,title,status,flag_id,counter_amount,counter_note,line_items,subtotal,tax_rate,tax_inclusive,total,project_id,workspace_id,token,
      projects(id,name,currency,clients(name,email,cc_emails),workspaces(id,agency_name,brand_colour))`)
    .eq('id', coId).eq('workspace_id', workspaceId).single()

  if (!co) return { ok: false, error: 'CO not found', status: 404 }
  if (co.status !== 'countered') return { ok: false, error: 'CO is not in countered status', status: 400 }

  const project = co.projects
  const client  = project?.clients
  const ws      = project?.workspaces
  if (!client?.email) return { ok: false, error: 'Client email required', status: 400 }

  const jwtSecret = await getWorkspaceJwtSecret(service, workspaceId)
  if (!jwtSecret) return { ok: false, error: 'Workspace signing secret not found', status: 500 }
  const secret     = new TextEncoder().encode(jwtSecret)
  const expiresAt  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const newToken   = await new SignJWT({
    coId, workspaceId, projectId: co.project_id,
    clientEmail: client.email, action: 'countersign',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresAt)
    .setJti(nanoid())
    .sign(secret)

  const now = new Date().toISOString()

  // FIX (section-10 audit, 10-B2): `co.total` was read here but never
  // selected above, so the fallback evaluated to `undefined` and flowed
  // straight into rescaleLineItemsToTotal. Masked today only because the
  // portal validates counter_amount > 0 before a CO can reach
  // 'countered' — but it also diverged from
  // app/api/co/[id]/accept-counter/route.ts, which DOES select `total`
  // and uses it to evaluate the approval gate, so the gate and the write
  // could reason over different values. Select it, and use a null-ish
  // check rather than `||` so a legitimate 0 can't silently fall through
  // to the original amount.
  const negotiatedTotal = co.counter_amount ?? co.total
  if (!Number.isFinite(Number(negotiatedTotal)))
    return { ok: false, error: 'This counter-offer has no amount to accept', status: 400 }
  const existingLineItems = typeof co.line_items === 'string'
    ? JSON.parse(co.line_items) : (co.line_items || [])
  const { lineItems: rescaledLineItems, subtotal: rescaledSubtotal, total: rescaledTotal } =
    rescaleLineItemsToTotal(existingLineItems, negotiatedTotal, co.tax_rate || 0, !!co.tax_inclusive)

  const { data: updatedCo, error: updateErr } = await (service as any)
    .from('change_orders').update({
      status:              'awaiting_countersignature',
      counter_accepted_at: now,
      counter_accepted_by: actorName,
      line_items:          rescaledLineItems,
      subtotal:            rescaledSubtotal,
      total:               rescaledTotal,
      token:               newToken,
      expires_at:          expiresAt.toISOString(),
      responded_at:        now,
      updated_at:          now,
    })
    .eq('id', coId)
    .eq('status', 'countered')
    .select('id')

  if (updateErr) return { ok: false, error: 'Failed to accept counter', status: 500 }
  if (!updatedCo || updatedCo.length === 0)
    return { ok: false, error: 'This counter-offer was already responded to', status: 409 }

  if (co.token) {
    try {
      await (service as any).from('revoked_tokens').insert({
        token: co.token, token_type: 'co', reason: 'superseded',
      })
    } catch (e) { console.error('revoked_tokens insert for superseded counter token failed:', e) }
  }

  await logAudit(service, {
    workspaceId, actorId, actorEmail, actorName,
    eventType: 'co.counter_accepted', entityType: 'change_order',
    entityId: coId, entityName: co.title,
    metadata: {
      counter_amount: co.counter_amount, accepted_by: actorName, awaiting_countersignature: true,
      ...(approvalRequestId ? { auto_sent_via_approval: approvalRequestId } : {}),
    },
  })

  const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/co/${newToken}`
  try {
    await sendCoCountersignatureRequestEmail({
      to: client.email, cc: client.cc_emails || [],
      clientName: client.name, agencyName: ws?.agency_name,
      projectName: project?.name, coTitle: co.title,
      total: rescaledTotal, currency: project?.currency || 'USD',
      portalUrl, brandColour: ws?.brand_colour,
    })
  } catch (e) { console.error('CO countersignature request email failed:', e) }

  return { ok: true, awaitingCountersignature: true }
}
