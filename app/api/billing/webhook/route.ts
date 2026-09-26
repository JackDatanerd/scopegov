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
import { logAudit } from '@/lib/utils/audit'
import { sendPaymentFailedEmail, sendCardExpiringEmail } from '@/lib/email/templates'
import { cancelPaystackSubscription, fetchPaystackNextPaymentDate } from '@/lib/integrations/paystack'
import { planCodeToTier, planCodeToInterval, fromSubunit, GRACE_DAYS } from '@/lib/billing/plans'
import { resolveWorkspace, type Resolution } from '@/lib/billing/resolve'
import { consumeCheckout } from '@/lib/billing/checkouts'
import { claimWebhookEvent, completeWebhookEvent, releaseWebhookEvent } from '@/lib/billing/webhook-claims'
import { getBillingRecipients } from '@/lib/billing/recipients'
import { alertBillingOps } from '@/lib/billing/ops-alert'

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

// FEATURE (deep audit, Billing re-pass): billing.payment_method_last4/
// payment_method_type (001_initial_schema.sql) were selected on
// settings/page.tsx and never written to anywhere — a fully scaffolded
// "card on file" feature with no data behind it. Paystack's subscription
// and charge payloads both carry an `authorization` object with the
// card's last4/brand; this just reads it instead of discarding it.
function extractPaymentMethod(data: any): { last4: string | null; type: string | null } {
  const auth = data?.authorization
  return {
    last4: auth?.last4 || null,
    type:  auth?.brand || auth?.card_type || auth?.channel || null,
  }
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

function must<T extends { error: any }>(res: T, label: string): T {
  if (res.error) throw new Error(`${label}: ${res.error.message ?? res.error}`)
  return res
}

const RESEND_NOTE = 'Paystack will not retry this — it needs a manual look.'

async function unresolved(service: any, event: any, why: string) {
  const d = event?.data
  await alertBillingOps(service, `billing:unresolved:${event?.event}`, `Paystack ${event?.event} could not be applied`, [
    why,
    `event: ${event?.event}`,
    `customer email: ${d?.customer?.email ?? '-'}`,
    `customer code: ${d?.customer?.customer_code ?? '-'}`,
    `subscription code: ${d?.subscription_code ?? d?.subscription?.subscription_code ?? '-'}`,
    `plan code: ${d?.plan?.plan_code ?? '-'}`,
    `reference: ${d?.reference ?? '-'}`,
    `amount (subunit): ${d?.amount ?? '-'} ${d?.currency ?? ''}`,
    RESEND_NOTE,
  ])
}

function isFuture(iso: string | null | undefined): iso is string {
  return !!iso && !isNaN(Date.parse(iso)) && Date.parse(iso) > Date.now()
}

async function audit(service: any, workspaceId: string, eventType: string, customerEmail: string | undefined, metadata: Record<string, unknown>) {
  await logAudit(service, {
    workspaceId, actorId: null,
    actorEmail: customerEmail || 'billing@paystack', actorName: 'Paystack',
    eventType, entityType: 'workspace', entityId: workspaceId, entityName: customerEmail,
    metadata,
  })
}

async function handleEvent(service: any, event: any): Promise<void> {
  const data = event.data
  switch (event.event) {
    // ── Plan upgrade / new subscription ───────────────────
    case 'subscription.create': {
      const customerEmail: string | undefined = data?.customer?.email
      const planCode: string | undefined = data?.plan?.plan_code
      const subCode: string | undefined = data?.subscription_code
      if (!customerEmail || !planCode || !subCode) { await unresolved(service, event, 'Malformed subscription.create payload.'); return }

      const newTier = planCodeToTier(planCode)
      if (!newTier) { await unresolved(service, event, `Unknown plan code ${planCode} — is the PAYSTACK_PLAN_* env var set for it? A customer has subscribed and nothing was applied.`); return }
      const newInterval = planCodeToInterval(planCode)

      // Bound to the server-recorded checkout, never to browser metadata.
      const res: Resolution = await resolveWorkspace(service, data, { checkout: 'strict', planCode })
      if (!res.workspaceId) {
        // FIX (deep audit, Billing re-pass — independent redo): see
        // lib/billing/resolve.ts / checkouts.ts. Ambiguous means we found
        // MORE THAN ONE workspace mid-checkout for this exact email+plan —
        // a real paid subscription that a human must attribute by hand,
        // not the generic "nothing matches" case below.
        if (res.ambiguous) {
          await unresolved(service, event, `A subscription was created, but more than one workspace has a pending checkout for this email + plan within the last 24h — could not tell which one actually paid. Attribute it by hand.`)
        } else {
          await unresolved(service, event, 'No pending checkout matches this subscription (email + plan). Created outside the app, or the checkout record expired.')
        }
        return
      }
      const workspaceId = res.workspaceId

      const prevWs = must(await service.from('workspaces').select('plan_tier').eq('id', workspaceId).maybeSingle(), 'read workspace').data
      const prevBilling = must(await service.from('billing')
        .select('paystack_subscription_code, paystack_email_token, plan_interval, current_period_end')
        .eq('workspace_id', workspaceId).maybeSingle(), 'read billing').data

      // Changing plans opens a fresh checkout, which creates a BRAND NEW
      // subscription; Paystack does not cancel the customer's other ones, so
      // disable the previous one or it keeps charging invisibly. Best-effort
      // for the write path (the new, already-paid subscription must still be
      // recorded) but a failure is now an alert, not a log line.
      let previousDisabled: boolean | undefined
      if (prevBilling?.paystack_subscription_code && prevBilling.paystack_subscription_code !== subCode) {
        const r = await cancelPaystackSubscription(prevBilling)
        previousDisabled = r.ok
        if (!r.ok) {
          await alertBillingOps(service, `billing:double-billing:${workspaceId}`, 'Previous subscription NOT disabled after a plan switch', [
            `workspace: ${workspaceId}`,
            `old subscription: ${prevBilling.paystack_subscription_code}`,
            `new subscription: ${subCode}`,
            `error: ${r.error}`,
            'The customer may be double-billed until the old subscription is disabled in the Paystack dashboard.',
          ])
        }
      }

      // BUG-054: planTier ONLY updated on webhook — never browser callback
      must(await service.from('workspaces').update({
        plan_tier: newTier, trial_ends_at: null, updated_at: new Date().toISOString(),
      }).eq('id', workspaceId), 'update workspace plan')

      const paymentMethod = extractPaymentMethod(data)
      // FIX (Billing re-pass #4): needs_paystack_cancel was hardcoded false
      // here regardless of `previousDisabled` — a failed disable above got a
      // one-shot ops alert and nothing durable. pending_cancel_subscription_
      // code/email_token (081) record the OLD subscription specifically, so
      // payment-overdue's step 4c can retry it without touching the NEW
      // subscription this same write installs below.
      const pendingCancel = previousDisabled === false
        ? { pending_cancel_subscription_code: prevBilling?.paystack_subscription_code ?? null,
            pending_cancel_email_token:       prevBilling?.paystack_email_token ?? null }
        : { pending_cancel_subscription_code: null, pending_cancel_email_token: null }
      must(await service.from('billing').upsert({
        workspace_id:               workspaceId,
        paystack_customer_code:     data.customer?.customer_code,
        paystack_subscription_code: subCode,
        paystack_email_token:       data.email_token || null,
        current_period_end:         data.next_payment_date,
        cancels_at_period_end:      false,
        grace_period_started_at:    null,
        needs_paystack_cancel:      false,
        ...pendingCancel,
        plan_interval:              newInterval,
        payment_method_last4:       paymentMethod.last4,
        payment_method_type:        paymentMethod.type,
        updated_at:                 new Date().toISOString(),
      }, { onConflict: 'workspace_id' }), 'upsert billing')

      if (res.checkout) await consumeCheckout(service, res.checkout.id)

      await audit(service, workspaceId, 'billing.plan_changed', customerEmail, {
        action: 'subscription_created',
        from: prevWs?.plan_tier, to: newTier,
        from_interval: prevBilling?.plan_interval ?? undefined, to_interval: newInterval,
        plan_code: planCode,
        // What the customer had already paid for on the old plan — needed to
        // credit them by hand, since Paystack does not prorate a switch.
        previous_period_end: prevBilling?.current_period_end ?? undefined,
        previous_subscription_disabled: previousDisabled,
        previous_subscription_cancel_pending_retry: previousDisabled === false,
      })
      return
    }

    // ── Payment success (first charge and every renewal) ──
    case 'charge.success': {
      const planCode: string | undefined = data?.plan?.plan_code
      const res = await resolveWorkspace(service, data, { checkout: 'prefer', planCode })
      if (!res.workspaceId) {
        // FIX (deep audit, Billing re-pass — independent redo): see
        // lib/billing/resolve.ts / checkouts.ts — more than one workspace
        // mid-checkout for this email+plan is a real payment that needs a
        // human to attribute, distinct from "genuinely not ours" below.
        if (res.ambiguous) {
          await unresolved(service, event, 'A subscription payment succeeded, but more than one workspace has a pending checkout for this email + plan within the last 24h — could not tell which one actually paid. Attribute it by hand.')
        } else if (planCode || data?.metadata?.workspaceId) {
          // One-off charges with no plan are not ours; a subscription charge
          // we cannot attribute is a customer who paid for something.
          await unresolved(service, event, 'A subscription payment succeeded but no workspace could be identified.')
        } else {
          console.log('Ignoring charge.success with no plan and no matching workspace')
        }
        return
      }
      if (res.superseded) { console.log('charge.success for a superseded subscription — ignoring'); return }
      const workspaceId = res.workspaceId
      const customerEmail: string | undefined = data?.customer?.email

      const billingRow = res.billing ?? must(await service.from('billing')
        .select('paystack_subscription_code').eq('workspace_id', workspaceId).maybeSingle(), 'read billing').data

      // current_period_end must move forward on every renewal or the
      // cancelled-subscription sweep downgrades someone mid-period. The
      // Subscription resource can still show the date that JUST elapsed if it
      // has not refreshed yet, so only accept a date that is in the future;
      // invoice.update (below) and the daily reconciliation cron repair the
      // rest.
      let nextPeriodEnd: string | null = null
      if (billingRow?.paystack_subscription_code) {
        const fetched = await fetchPaystackNextPaymentDate(billingRow.paystack_subscription_code)
        if (isFuture(fetched)) nextPeriodEnd = fetched
        else console.warn(`[BILLING] next_payment_date for workspace ${workspaceId} was not in the future after a charge (${fetched}); leaving current_period_end for invoice.update / reconciliation`)
      }

      if (billingRow) {
        const paymentMethod = extractPaymentMethod(data)
        must(await service.from('billing').update({
          grace_period_started_at: null,
          ...(nextPeriodEnd ? { current_period_end: nextPeriodEnd } : {}),
          ...(paymentMethod.last4 ? { payment_method_last4: paymentMethod.last4, payment_method_type: paymentMethod.type } : {}),
          updated_at: new Date().toISOString(),
        }).eq('workspace_id', workspaceId), 'update billing after charge')
      }

      await audit(service, workspaceId, 'billing.payment_succeeded', customerEmail, {
        amount: fromSubunit(data?.amount), currency: data?.currency,
        reference: data?.reference, channel: data?.channel, plan_code: planCode,
        interval: planCodeToInterval(planCode) ?? undefined,
        paid_at: data?.paid_at ?? data?.paidAt,
      })
      return
    }

    // ── Renewal invoice settled — authoritative next-charge date ─
    case 'invoice.update': {
      const paid = data?.paid === true || data?.status === 'success'
      if (!paid) return
      const res = await resolveWorkspace(service, data)
      if (!res.workspaceId || res.superseded) return
      const next = data?.subscription?.next_payment_date
      must(await service.from('billing').update({
        grace_period_started_at: null,
        ...(isFuture(next) ? { current_period_end: next } : {}),
        updated_at: new Date().toISOString(),
      }).eq('workspace_id', res.workspaceId), 'update billing from invoice')
      return
    }

    // ── Payment failed — start (once) the grace period ─────
    case 'invoice.payment_failed': {
      const customerEmail: string | undefined = data?.customer?.email
      const res = await resolveWorkspace(service, data)
      if (!res.workspaceId) { await unresolved(service, event, 'A payment failed but no workspace could be identified, so no grace period was started.'); return }
      if (res.superseded) { console.log('invoice.payment_failed for a superseded subscription — ignoring'); return }
      const workspaceId = res.workspaceId

      const now = new Date().toISOString()
      // Only the FIRST failure starts the window; Paystack's later retries
      // must not push it out (see point 5 at the top of this file).
      const started = must(await service.from('billing')
        .update({ grace_period_started_at: now, updated_at: now })
        .eq('workspace_id', workspaceId).is('grace_period_started_at', null)
        .select('workspace_id'), 'start grace period').data
      const newlyStarted = (started || []).length > 0

      await audit(service, workspaceId,
        newlyStarted ? 'billing.payment_failed_grace_started' : 'billing.payment_retry_failed',
        customerEmail, { amount: fromSubunit(data?.amount), currency: data?.currency, reference: data?.reference })

      if (newlyStarted) {
        const ws = must(await service.from('workspaces').select('agency_name').eq('id', workspaceId).maybeSingle(), 'read workspace').data
        const recipients = await getBillingRecipients(service, workspaceId, [{ email: customerEmail }])
        for (const r of recipients) {
          try {
            await sendPaymentFailedEmail({
              to: r.email, name: r.name, agencyName: ws?.agency_name || 'your workspace',
              upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
              graceDaysLeft: GRACE_DAYS,
            })
          } catch (e) { console.error('Payment failed email error:', e) }
        }
      }
      return
    }

    // ── Cancellation / disable ─────────────────────────────
    // (Rationale for the superseded-subscription check and for leaving
    // paystack_subscription_code in place is unchanged from earlier rounds:
    // a plan switch disables the OLD subscription, which fires this same
    // event, and resume needs the code until the paid period lapses.)
    case 'subscription.disable':
    case 'subscription.not_renew': {
      const res = await resolveWorkspace(service, data)
      // FIX (deep audit, Billing re-pass — independent redo): every other
      // "could not confidently resolve a workspace" branch in this file
      // (invoice.payment_failed, charge.success with a plan code,
      // subscription.create) calls unresolved()/alertBillingOps so a human
      // sees it. This one only ever logged to console — a real cancellation
      // or non-renewal signal from Paystack could vanish with zero
      // visibility. Reachable when the event's subscription code has
      // already been superseded on our side AND the customer code is
      // ambiguous across more than one workspace (this app explicitly
      // supports one login owning several — see lib/billing/resolve.ts's
      // header). An unambiguous "genuinely unknown to us" case (no
      // workspaceId, not ambiguous) is left as a log line, same as
      // subscription.expiring_cards' silent skip for an unmatched item —
      // there is nothing a human can act on for a subscription this app
      // never created. An ambiguous one means we DID recognize the customer
      // but couldn't tell which of their workspaces it's for, which is
      // exactly the "needs a human" case this file alerts on everywhere else.
      if (!res.workspaceId) {
        if (res.ambiguous) await unresolved(service, event, `A subscription was ${event.event === 'subscription.not_renew' ? 'set to not renew' : 'disabled'}, but the customer code matches more than one workspace — could not tell which one to update.`)
        else console.log(`Paystack ${event.event} matched no workspace — ignoring`)
        return
      }
      if (res.superseded) { console.log(`Paystack ${event.event} for a superseded subscription — ignoring (expected after a plan switch)`); return }
      // The cancel route already recorded it and logged it; don't duplicate.
      if (res.billing?.cancels_at_period_end) return

      must(await service.from('billing').update({
        cancels_at_period_end: true, updated_at: new Date().toISOString(),
      }).eq('workspace_id', res.workspaceId), 'mark cancellation')

      await audit(service, res.workspaceId, 'billing.plan_changed', data?.customer?.email, {
        action: event.event === 'subscription.not_renew' ? 'subscription_not_renewing' : 'subscription_disabled',
        ends_at: res.billing?.current_period_end ?? undefined,
      })
      return
    }

    // ── Card about to expire (Paystack sends a batch monthly) ─
    case 'subscription.expiring_cards': {
      const items: any[] = Array.isArray(data) ? data : data ? [data] : []
      for (const item of items) {
        const res = await resolveWorkspace(service, { subscription: item?.subscription, customer: item?.customer })
        if (!res.workspaceId || res.superseded) continue
        const since = new Date(Date.now() - 20 * 86400000).toISOString()
        const { data: already } = await service.from('audit_log').select('id')
          .eq('workspace_id', res.workspaceId).eq('event_type', 'billing.card_expiring').gte('created_at', since).limit(1)
        if (already && already.length) continue
        const ws = must(await service.from('workspaces').select('agency_name').eq('id', res.workspaceId).maybeSingle(), 'read workspace').data
        const recipients = await getBillingRecipients(service, res.workspaceId, [{ email: item?.customer?.email }])
        for (const r of recipients) {
          try {
            await sendCardExpiringEmail({
              to: r.email, name: r.name, agencyName: ws?.agency_name || 'your workspace',
              cardLabel: item?.description || [item?.brand, item?.last4 && `ending ${item.last4}`].filter(Boolean).join(' ') || 'your card',
              expiryLabel: item?.expiry_date || 'soon',
              manageUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            })
          } catch (e) { console.error('Card expiring email error:', e) }
        }
        await audit(service, res.workspaceId, 'billing.card_expiring', item?.customer?.email, { expiry_date: item?.expiry_date ?? undefined })
      }
      return
    }

    // ── Money coming back out: disputes and refunds ────────
    // Deliberately NOT auto-downgraded: whether a chargeback or partial
    // refund should end access is a business call. They are now recorded and
    // escalated instead of falling into the default branch and vanishing.
    case 'charge.dispute.create':
    case 'charge.dispute.resolve':
    case 'refund.processed':
    case 'refund.failed': {
      const res = await resolveWorkspace(service, data)
      if (res.workspaceId) {
        await audit(service, res.workspaceId, `billing.${event.event.replace(/\./g, '_')}`, data?.customer?.email, {
          amount: fromSubunit(data?.amount ?? data?.refund_amount), currency: data?.currency,
          reference: data?.transaction_reference ?? data?.transaction?.reference ?? data?.reference,
          status: data?.status, resolution: data?.resolution,
        })
      }
      await alertBillingOps(service, `billing:incident:${event.event}`, `Paystack ${event.event}`, [
        `event: ${event.event}`,
        `workspace: ${res.workspaceId ?? 'unresolved'}`,
        `customer: ${data?.customer?.email ?? '-'}`,
        `reference: ${data?.transaction_reference ?? data?.transaction?.reference ?? data?.reference ?? '-'}`,
        `status: ${data?.status ?? '-'}`,
        'Decide manually whether the workspace should be downgraded.',
      ], 5 * 60_000)
      return
    }

    default:
      console.log('Unhandled Paystack event:', event.event)
  }
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
