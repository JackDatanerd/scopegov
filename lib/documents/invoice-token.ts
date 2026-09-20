// lib/documents/invoice-token.ts
//
// FIX (cron/portal audit round 2). One place that turns a portal invoice token into an invoice, used by
// the portal GET, PDF and dispute routes (each used to carry its own copy of this logic).
//
// What was wrong with the old copies:
//  * renewInvoiceTokenIfExpired() overwrites invoices.token with a fresh JWT, but the client's EMAILED
//    link still holds the old one — which then matched nothing (404) and was never delivered a
//    replacement. The comment there promised "the portal link keeps working"; for the link the client
//    actually has, it did not. SOW and CO links solved the same problem with a revoked_tokens row
//    (reason 'superseded' + document_id); invoices now do too.
//  * A revoked row of ANY kind returned 410, which would now wrongly kill superseded links.
//  * jwtVerify rejected an expired token even though the token is only a bearer credential for a debt
//    that is still owed (see renew-invoice-token.ts), so a link one day past its 90 days died until the
//    nightly cron got to it. Expiry alone is tolerated for a live/paid invoice whose token still matches
//    the row exactly.

import { jwtVerify } from 'jose'
import { getWorkspaceJwtSecret, isWorkspaceDeleted } from '@/lib/utils/workspace-secret'

// Statuses whose link may outlive its JWT expiry (a debt still owed, or a paid invoice viewed as a receipt).
const EXPIRY_TOLERATED = ['sent', 'partially_paid', 'overdue', 'paid']

export type InvoiceTokenResult =
  | { ok: true; invoice: any; viaSuperseded: boolean }
  | { ok: false; status: number; error: string }

export async function resolveInvoiceToken(service: any, token: string, select: string): Promise<InvoiceTokenResult> {
  const { data: revoked } = await service
    .from('revoked_tokens').select('reason, document_id').eq('token', token).maybeSingle()
  if (revoked && revoked.reason !== 'superseded')
    return { ok: false, status: 410, error: 'Link no longer active' }

  let viaSuperseded = false
  let { data: invoice } = await service.from('invoices').select(select).eq('token', token).maybeSingle()

  // The token was rotated by the renewal cron: resolve the live row by id. Holding the exact old token is
  // the same proof of possession as holding the current one (mirrors the SOW/CO portals).
  if (!invoice && revoked?.reason === 'superseded' && revoked.document_id) {
    const { data: byId } = await service.from('invoices').select(select).eq('id', revoked.document_id).maybeSingle()
    if (byId) { invoice = byId; viaSuperseded = true }
  }
  if (!invoice) return { ok: false, status: 404, error: 'Invoice not found' }

  if (invoice.status === 'draft' || invoice.status === 'void')
    return { ok: false, status: 409, error: 'This invoice is no longer available' }
  if (await isWorkspaceDeleted(service, invoice.workspace_id))
    return { ok: false, status: 410, error: 'Link no longer active' }

  if (!viaSuperseded) {
    try {
      const jwtSecret = await getWorkspaceJwtSecret(service, invoice.workspace_id)
      if (!jwtSecret) throw new Error('no secret')
      await jwtVerify(token, new TextEncoder().encode(jwtSecret))
    } catch (e: any) {
      const expiredOnly = e?.code === 'ERR_JWT_EXPIRED' && EXPIRY_TOLERATED.includes(invoice.status)
      if (!expiredOnly) return { ok: false, status: 401, error: 'Invalid or expired link' }
    }
  }
  return { ok: true, invoice, viaSuperseded }
}
