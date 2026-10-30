export const runtime = 'nodejs'
// FIX (deep audit, Billing re-pass — independent redo): no explicit
// maxDuration was set, so this route ran under Vercel's platform default
// (as low as 10s) — the same class of bug already fixed in
// app/api/sow/generate/route.ts (see its comment). Paystack calls in this
// file (cancelPaystackSubscription, fetchPaystackNextPaymentDate) each carry
// their own 12s internal timeout (lib/integrations/paystack.ts), and
// fetchPaystackNextPaymentDate runs on every ordinary renewal charge, not
// just an edge case — a legitimately slow-but-successful Paystack response
// could already exceed the platform default on its own, before counting the
// DB round-trips and email sends around it. A mid-write kill never reaches
// the catch block, so the claim (lib/billing/webhook-claims.ts) is left
// 'processing' until STALE_CLAIM_MS lets a retry take over.
export const maxDuration = 60

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { claimWebhookEvent, completeWebhookEvent, releaseWebhookEvent } from '@/lib/billing/webhook-claims'
import { handleEvent } from '@/lib/billing/webhook-handler'

// Billing re-pass #3 — what this file does differently from the version it
// replaces (each point is a bug that shipped real money problems):
//
//  1. CLAIM-based idempotency (lib/billing/webhook-claims.ts). The old code
//     recorded the idempotency key before working and never released it, so
//     one transient failure turned every Paystack retry into a "duplicate"
//     and the payment event was lost for good.
//  2. Every database write is checked. supabase-js resolves to { error }
//     instead of throwing, and none of these writes were read, so a failed
//     workspace upgrade still returned 200 (and consumed the idempotency
//     key). A failed write now throws -> 500 -> claim released -> retried.
//  3. The workspace is resolved from what we stored server-side
//     (lib/billing/resolve.ts), never from browser metadata or whichever
//     workspace the payer has selected right now.
//  4. Anything that needs a human (an unattributable payment, an unknown plan
//     code, a previous subscription we could not disable, a dispute, a
//     refund) raises an ops alert instead of a lone console.error.
//  5. The grace period starts once. Paystack retries a failed charge and
//     emits invoice.payment_failed each time; the old handler overwrote
//     grace_period_started_at on every one, sliding the window forward and
//     re-sending the dunning email each time, so enforcement could be
//     postponed indefinitely.

// BUG-007 / BUG-054: Web Crypto HMAC — never import Node crypto in edge/serverless
async function verifyPaystackSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false
  const secret  = process.env.PAYSTACK_SECRET_KEY
  if (!secret)  return false
  const encoder = new TextEncoder()
  const key     = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  )
  const sig     = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  const hash    = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  return timingSafeEqualStr(hash, signature)
}

// FIX (audit round 2, item #4): plain `===` short-circuits on the first
// mismatched character — a timing side-channel for signature forgery.
// crypto.timingSafeEqual isn't usable here without importing Node's
// crypto module, which BUG-007/054 above deliberately avoids for
// edge/serverless compatibility, so this is a manual constant-time
// comparison instead: always walks the full (fixed) hash length,
// accumulating mismatches with XOR rather than branching or returning
// early on the first difference.
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// FIX (audit round 6): Paystack, like any payment provider, redelivers
// webhooks on timeout or a non-2xx response — nothing here recognized "I
// already processed this exact event," so a redelivery would re-send
// customer-facing emails (invoice.payment_failed's dunning email, most
// visibly) and double-log audit entries. Hash the raw request body as the
// idempotency key: a genuine redelivery sends byte-identical bytes, while
// distinct events (even of the same type, e.g. two separate failed
// invoices) always differ somewhere (timestamps at minimum) — more
// robust than trying to pick the "right" id field per event type, some
// of which don't reliably have one.
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function POST(request: NextRequest) {
  let service: any = null
  let claimedKey: string | null = null
  // FIX (deep audit, Billing re-pass — independent redo): see
  // lib/billing/webhook-claims.ts's header. complete/release now require the
  // exact claimed_at this request was handed, so a slow-but-still-alive
  // attempt whose claim was taken over by a retry in the meantime can never
  // complete or delete the NEW owner's row out from under it.
  let claimedAt: string | null = null
  try {
    const rawBody = await request.text()
    const sig     = request.headers.get('x-paystack-signature')

    if (!await verifyPaystackSignature(rawBody, sig)) {
      console.warn('Paystack signature verification failed')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    let event: any
    try { event = JSON.parse(rawBody) } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
    service = createServiceClient()

    // Event type only — customer emails no longer go to the logs.
    console.log('Paystack webhook event:', event.event)

    const idempotencyKey = `${event.event}:${await sha256Hex(rawBody)}`
    const claim = await claimWebhookEvent(service, idempotencyKey)
    if (claim.status === 'duplicate') {
      console.log('Duplicate Paystack webhook delivery, skipping:', idempotencyKey)
      return NextResponse.json({ received: true, duplicate: true })
    }
    if (claim.status === 'in_progress') {
      // Another delivery of this exact event is being processed right now.
      return NextResponse.json({ error: 'Event is being processed' }, { status: 409 })
    }
    claimedKey = idempotencyKey
    claimedAt = claim.claimedAt

    await handleEvent(service, event)
    await completeWebhookEvent(service, idempotencyKey, claimedAt!)
    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('Paystack webhook error:', err)
    // Give the event back so Paystack's retry actually re-runs it.
    if (service && claimedKey && claimedAt) await releaseWebhookEvent(service, claimedKey, claimedAt)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
