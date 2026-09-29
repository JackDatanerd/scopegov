// lib/email/webhook.ts
//
// Verification and state logic for Resend's delivery webhooks (Svix-signed). Implemented with
// node:crypto directly instead of adding the `svix` package for one HMAC check.
//
// Svix scheme: the signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the
// base64-decoded part of the `whsec_…` secret, base64-encoded; the `svix-signature` header holds one
// or more space-separated `v1,<signature>` entries (more than one during secret rotation).

import { createHmac, timingSafeEqual } from 'node:crypto'

const TOLERANCE_SECONDS = 5 * 60

export function verifyResendSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature || !secret) return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) return false // replay guard

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest()

  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    let given: Buffer
    try { given = Buffer.from(sig, 'base64') } catch { continue }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true
  }
  return false
}

export type EmailKindRole = 'send' | 'reminder' | 'notice' | 'confirmation' | 'other'

/**
 * Classify an email_log `kind` ('sow.send', 'co.withdraw_notice', 'invoice.auto_reminder', …) so the bounce
 * alert can say something accurate. `_reminder` covers both '.reminder' and '.auto_reminder'.
 */
export function classifyEmailKind(kind: string | null | undefined): { docKind: string; role: EmailKindRole } {
  const k = String(kind || '')
  const docKind = k.split('.')[0]
  const tail = k.includes('.') ? k.slice(k.indexOf('.') + 1) : ''
  let role: EmailKindRole = 'other'
  if (tail === 'send' || tail === 'countersign_request') role = 'send'
  else if (/(^|_)reminder$/.test(tail)) role = 'reminder'
  else if (/_notice$/.test(tail)) role = 'notice'
  else if (/_(confirmation|receipt)$/.test(tail)) role = 'confirmation'
  return { docKind, role }
}

/** Body of the in-app alert raised for the sender when an email bounces. `what` is e.g. 'invoice'. */
export function bounceAlertBody(role: EmailKindRole, what: string): string {
  switch (role) {
    case 'reminder':     return `Your reminder for the ${what} was not delivered. Check the address on the client record, then resend.`
    case 'send':         return `Your ${what} was not delivered. Check the address on the client record, then resend.`
    case 'notice':       return `The ${what} notice to your client was not delivered, so they may still act on the old link. Check the address on the client record and let them know another way.`
    case 'confirmation': return `The ${what} confirmation email to your client was not delivered. Check the address on the client record and share their copy another way.`
    default:             return `An email about your ${what} was not delivered. Check the address on the client record.`
  }
}

export type EmailLogStatus = 'sent' | 'delayed' | 'delivered' | 'failed' | 'bounced' | 'complained'

// A later event must never downgrade an earlier, more final one (webhooks arrive out of order and
// are retried): a "delivered" that lands after a "bounced" is stale.
const RANK: Record<EmailLogStatus, number> = { sent: 0, delayed: 1, delivered: 2, failed: 3, bounced: 4, complained: 5 }

const EVENT_STATUS: Record<string, EmailLogStatus> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
}

/** The status the row should move to, or null if the event is irrelevant or would not advance it. */
export function nextEmailStatus(current: string, eventType: string): EmailLogStatus | null {
  const target = EVENT_STATUS[eventType]
  if (!target) return null
  const cur = (current in RANK ? current : 'sent') as EmailLogStatus
  return RANK[target] > RANK[cur] ? target : null
}
