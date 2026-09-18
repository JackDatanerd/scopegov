// lib/documents/renew-invoice-token.ts
//
// FIX (build, cron/portal audit round — flagship finding, section 18):
// sow-expiry and co-expiry (app/api/cron/{sow,co}-expiry) exist because a
// client's signing link dies after 30 days with zero signal to the agency
// and no path back except manually starting a fresh version. Invoices
// mint the exact same kind of 90-day JWT (see sendInvoiceDocument in
// send-invoice.ts) and had NO equivalent — no cron, and the one manual
// tool that exists (api/invoices/[id]/remind) just resends the reminder
// email pointing at the SAME stored token, so it doesn't rescue a dead
// link either.
//
// An invoice's `expires_at` isn't a business deadline the way a SOW/CO's
// is — nobody is "offering" anything with a countdown; the token is just
// a bearer credential for viewing/paying a debt that's still owed
// regardless of whether some JWT aged out. So unlike SOW/CO expiry (which
// deliberately kills the document and makes the agency start over), the
// right behaviour here is to just quietly mint a fresh token + expiry
// once the old one is gone, so the portal link keeps working for as long
// as the invoice itself is still live. This is that one shared operation,
// used by both the new invoice-expiry cron and (defensively) the remind
// route, instead of duplicating token-minting logic a third time.
//
// Deliberately narrow: no status/invoice_number/PDF/email side effects —
// those belong to sendInvoiceDocument's first-send flow. This only ever
// touches token/expires_at, and only for an invoice already out with a
// client (status IN 'sent'/'partially_paid'/'overdue' — never draft,
// which has no token yet, and never paid/void, which are terminal and
// don't need a live link).

import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

const LIVE_INVOICE_STATUSES = ['sent', 'partially_paid', 'overdue']

export async function renewInvoiceTokenIfExpired(
  service: any, invoiceId: string, workspaceId: string,
  currentStatus: string, currentExpiresAt: string | null,
): Promise<{ renewed: boolean; token?: string }> {
  if (!LIVE_INVOICE_STATUSES.includes(currentStatus)) return { renewed: false }
  if (currentExpiresAt && new Date(currentExpiresAt) > new Date()) return { renewed: false }

  const jwtSecret = await getWorkspaceJwtSecret(service, workspaceId)
  if (!jwtSecret) return { renewed: false }
  const secret    = new TextEncoder().encode(jwtSecret)
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  const token     = await new SignJWT({
    invoiceId, workspaceId, action: 'view',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresAt)
    .setJti(nanoid())
    .sign(secret)

  // CAS on status so a payment/void racing this doesn't get its terminal
  // state clobbered — this never touches status itself, but re-checking
  // it at write time keeps the guarantee that a token is only ever
  // (re)issued for a genuinely live invoice.
  const { data: updated } = await (service as any).from('invoices')
    .update({ token, expires_at: expiresAt.toISOString(), updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .in('status', LIVE_INVOICE_STATUSES)
    .select('id')

  if (!updated?.length) return { renewed: false }
  return { renewed: true, token }
}
