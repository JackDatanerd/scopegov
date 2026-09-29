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
import { consumeCheckoutGroup, stampCheckoutCharged } from '@/lib/billing/checkouts'
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

// FIX (deep audit, Billing re-pass — independent redo): alertBillingOps's
// cooldown key was just `billing:unresolved:${event.event}` (and, further
// down, `billing:incident:${event.event}`) — the EVENT TYPE alone, with no
// reference to which customer or transaction it's about. Two different
// customers each triggering an unresolved subscription.create, or two
// unrelated disputes, within the cooldown window (60 min / 5 min) collapse
// onto the same key: only the first gets an ops email, the second is
// reduced to a console.error nobody watches — the exact failure mode this
// whole alerting system exists to fix. Fold in whatever identifies the
// specific incident (subscription code, else customer code, else the
// transaction reference, else the email) so distinct incidents of the same
// event type get their own cooldown, while genuine redeliveries of the
// SAME incident still collapse onto one alert as intended.
function incidentKey(data: any): string {
  return (
    data?.subscription_code ||
    data?.subscription?.subscription_code ||
    data?.customer?.customer_code ||
    data?.transaction_reference ||
    data?.transaction?.reference ||
    data?.reference ||
    data?.customer?.email ||
    'unknown'
  )
}

async function unresolved(service: any, event: any, why: string) {
  const d = event?.data
  await alertBillingOps(service, `billing:unresolved:${event?.event}:${incidentKey(d)}`, `Paystack ${event?.event} could not be applied`, [
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

// FIX (Billing independent pass — B2): this awaited logAudit and threw its result
// away. logAudit resolves `false` on a failed insert (it never throws, by design,
// so a user action isn't failed by an audit hiccup) and its own header says the
// billing webhook is the caller that must react. Here the audit row is not a
// side note: billing/history is built ONLY from audit_log, so a payment whose row
// failed to write vanishes from the customer's Payment history, and the claim
// was still marked done, so nothing would ever retry it.
//
// One immediate retry absorbs a blip. If the row still cannot be written:
//  - `redeliverable: true` throws, so the webhook returns 500, the claim is
//    released and Paystack redelivers. Used only where a redelivery genuinely
//    RE-RUNS the audit call (charge.success, invoice.payment_failed, the
//    dispute/refund family) — those handlers' writes are idempotent.
//  - otherwise (subscription.create / subscription.disable): a redelivery takes
//    the "already applied" / "already cancelling" early exit and would never
//    write the row either, so throwing would only produce a stream of 500s. Page
//    ops with everything needed to add the entry by hand instead.
async function audit(
  service: any, workspaceId: string, eventType: string, customerEmail: string | undefined,
  metadata: Record<string, unknown>, opts: { redeliverable?: boolean } = {},
) {
  const write = () => logAudit(service, {
    workspaceId, actorId: null,
    actorEmail: customerEmail || 'billing@paystack', actorName: 'Paystack',
    eventType, entityType: 'workspace', entityId: workspaceId, entityName: customerEmail,
    metadata,
  })
  if (await write()) return
  await new Promise(r => setTimeout(r, 250))
  if (await write()) return
  await alertBillingOps(service, `billing:audit-write:${eventType}:${workspaceId}:${String(metadata.reference ?? metadata.plan_code ?? metadata.action ?? 'x')}`,
    'Billing audit row could not be written', [
      `workspace: ${workspaceId}`,
      `event type: ${eventType}`,
      `customer: ${customerEmail ?? '-'}`,
      `metadata: ${JSON.stringify(metadata).slice(0, 800)}`,
      opts.redeliverable
        ? 'The webhook will be retried by Paystack. If this keeps recurring, add the entry to audit_log by hand.'
        : 'Paystack will NOT retry this usefully — the change itself was applied; add the entry to audit_log by hand so Payment history is complete.',
    ])
  if (opts.redeliverable) throw new Error(`audit write failed for ${eventType} (workspace ${workspaceId})`)
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

      // FIX (Billing re-pass, independent redo #3 — B4): idempotent by
      // subscription code. A previous attempt that applied everything below
      // but died before its claim was marked done (a timeout, a failed
      // completeWebhookEvent) is redelivered after the claim goes stale — by
      // then the checkout is already consumed, so the strict lookup found
      // nothing and raised a false "no pending checkout matches" page for a
      // subscription that was applied correctly. If a billing row already
      // holds this exact subscription code the work is done: sweep any
      // leftover checkout rows for that workspace + plan and stop.
      {
        const applied = must(await service.from('billing').select('workspace_id')
          .eq('paystack_subscription_code', subCode).maybeSingle(), 'read billing by subscription').data
        if (applied?.workspace_id) {
          const { error: sweepErr } = await service.from('billing_checkouts')
            .update({ consumed_at: new Date().toISOString() })
            .eq('workspace_id', applied.workspace_id).eq('email', customerEmail.trim().toLowerCase())
            .eq('plan_code', planCode).is('consumed_at', null)
          if (sweepErr) console.error('[BILLING] could not sweep checkouts for an already-applied subscription:', sweepErr.message)
          console.log('subscription.create for a subscription already on file — already applied, ignoring')
          return
        }
      }

      // Bound to the server-recorded checkout, never to browser metadata.
      const res: Resolution = await resolveWorkspace(service, data, { checkout: 'strict', planCode })
      if (!res.workspaceId) {
        // FIX (deep audit, Billing re-pass — independent redo): see
        // lib/billing/resolve.ts / checkouts.ts. Ambiguous means we found
        // MORE THAN ONE workspace mid-checkout for this exact email+plan —
        // a real paid subscription that a human must attribute by hand,
        // not the generic "nothing matches" case below.
        if (res.ambiguous && res.awaitingCharge) {
          // FIX (Billing independent pass — B4): several workspaces have an open
          // checkout for this email + plan and NONE has had a payment resolved to it
          // yet — charge.success (which stamps the paid checkout) has not been
          // processed. Paystack does not guarantee the order of these two events, so
          // this is "not decidable yet", not "undecidable": returning normally would
          // end the claim as done and the paid subscription would never be applied
          // (Paystack does not redeliver a 200). Page ops so a permanent case is not
          // silent, then fail so the claim is released and the redelivery decides.
          await unresolved(service, event, 'A subscription was created while several workspaces have an open checkout for this email + plan and none has been matched to a payment yet (charge.success has not landed). It will be retried automatically; if this keeps recurring, attribute it by hand.')
          throw new Error(`subscription.create for ${subCode}: waiting for charge.success to identify which of several open checkouts was paid`)
        }
        if (res.ambiguous) {
          await unresolved(service, event, `A subscription was created, but more than one workspace has a pending checkout for this email + plan within the last 24h — could not tell which one actually paid. Attribute it by hand.`)
        } else {
          await unresolved(service, event, 'No pending checkout matches this subscription (email + plan). Created outside the app, or the checkout record expired.')
        }
        return
      }
      const workspaceId = res.workspaceId

      // FIX (Billing re-pass, independent redo #3 — B3): a workspace that was
      // deleted or suspended (both stamp deleted_at) after its checkout was
      // recorded — a popup left open, paid later — must not receive a live
      // subscription: workspace/delete and admin suspend cancel billing
      // exactly so nothing keeps charging a workspace nobody can reach. Pending
      // checkouts live 24h and used to survive both, and nothing here looked.
      // Disable the just-created subscription, consume the checkout, and page
      // ops — the first charge already went through and needs a manual refund.
      const wsState = must(await service.from('workspaces').select('plan_tier, deleted_at').eq('id', workspaceId).maybeSingle(), 'read workspace').data
      if (!wsState || wsState.deleted_at) {
        const off = await cancelPaystackSubscription({ paystack_subscription_code: subCode, paystack_email_token: data.email_token || null })
        if (res.checkout) await consumeCheckoutGroup(service, res.checkout)
        await alertBillingOps(service, `billing:dead-workspace:${workspaceId}:${subCode}`, 'Subscription created for a deleted/suspended workspace', [
          `workspace: ${workspaceId}`,
          `subscription: ${subCode}`,
          `customer email: ${customerEmail}`,
          `new subscription disabled: ${off.ok ? 'yes' : `NO — ${off.error}`}`,
          'The customer\'s first charge already succeeded — refund it in the Paystack dashboard' + (off.ok ? '.' : ' and disable the subscription by hand, or it will keep renewing.'),
        ])
        return
      }

      const prevWs = { plan_tier: wsState.plan_tier }
      const prevBilling = must(await service.from('billing')
        .select('paystack_subscription_code, paystack_email_token, plan_interval, current_period_end')
        .eq('workspace_id', workspaceId).maybeSingle(), 'read billing').data

      // Changing plans opens a fresh checkout, which creates a BRAND NEW
      // subscription; Paystack does not cancel the customer's other ones, so
      // the previous one must be disabled or it keeps charging invisibly.
      //
      // FIX (Billing independent pass 7 — B2): the order used to be disable-old
      // FIRST, write-new-row after. Disabling makes Paystack fire
      // subscription.disable for the OLD code, and that event can reach this
      // webhook before the new billing row below is written — the old code was
      // still on file, so it was treated as a genuine cancellation: a false
      // `subscription_disabled` row in the customer's Payment history (and a
      // transient cancels_at_period_end flag). Now:
      //   1. durably record the old subscription as pending-disable
      //      (billing_pending_subscription_cancels, retried daily by
      //      payment-overdue 4c) — so a crash after the row swap below can
      //      never leave the old subscription charging with no record, since a
      //      redelivery would take the "already applied" early exit;
      //   2. write the new plan + billing row;
      //   3. only then disable the old subscription. Its disable event now
      //      finds the new code on file and is ignored as superseded.
      const oldSubCode = prevBilling?.paystack_subscription_code && prevBilling.paystack_subscription_code !== subCode
        ? prevBilling.paystack_subscription_code : null
      if (oldSubCode) {
        must(await service.from('billing_pending_subscription_cancels').upsert({
          workspace_id:      workspaceId,
          subscription_code: oldSubCode,
          email_token:       prevBilling!.paystack_email_token ?? null,
        }, { onConflict: 'workspace_id,subscription_code' }), 'record pending old-subscription cancel')
      }

      // BUG-054: planTier ONLY updated on webhook — never browser callback
      must(await service.from('workspaces').update({
        plan_tier: newTier, trial_ends_at: null, updated_at: new Date().toISOString(),
      }).eq('id', workspaceId), 'update workspace plan')

      const paymentMethod = extractPaymentMethod(data)
      must(await service.from('billing').upsert({
        workspace_id:               workspaceId,
        paystack_customer_code:     data.customer?.customer_code,
        paystack_subscription_code: subCode,
        paystack_email_token:       data.email_token || null,
        current_period_end:         data.next_payment_date,
        cancels_at_period_end:      false,
        grace_period_started_at:    null,
        needs_paystack_cancel:      false,
        plan_interval:              newInterval,
        payment_method_last4:       paymentMethod.last4,
        payment_method_type:        paymentMethod.type,
        updated_at:                 new Date().toISOString(),
      }, { onConflict: 'workspace_id' }), 'upsert billing')

      // Best-effort: the new, already-paid subscription is recorded above
      // either way. A failure is an alert and stays in the pending table for
      // the daily retry; a success removes the pending row.
      let previousDisabled: boolean | undefined
      if (oldSubCode) {
        const r = await cancelPaystackSubscription({ paystack_subscription_code: oldSubCode, paystack_email_token: prevBilling!.paystack_email_token ?? null })
        previousDisabled = r.ok
        if (r.ok) {
          const { error: clearErr } = await service.from('billing_pending_subscription_cancels').delete()
            .eq('workspace_id', workspaceId).eq('subscription_code', oldSubCode)
          if (clearErr) console.error('[BILLING] could not clear pending old-subscription cancel (the daily retry will find it already disabled):', clearErr.message)
        } else {
          await alertBillingOps(service, `billing:double-billing:${workspaceId}`, 'Previous subscription NOT disabled after a plan switch', [
            `workspace: ${workspaceId}`,
            `old subscription: ${oldSubCode}`,
            `new subscription: ${subCode}`,
            `error: ${r.error}`,
            'The customer may be double-billed until the old subscription is disabled in the Paystack dashboard. It is queued for the daily retry.',
          ])
        }
      }

      if (res.checkout) await consumeCheckoutGroup(service, res.checkout)

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

      // FIX (Billing independent pass — B4): record that THIS checkout is the one a
      // payment was actually resolved to, so a subscription.create that cannot tell
      // several open checkouts apart (no metadata on a Subscription payload) can
      // still pick the paid one. Throws on failure -> claim released -> redelivery.
      if (res.via === 'checkout' && res.checkout) {
        await stampCheckoutCharged(service, res.checkout, data?.authorization?.authorization_code)
      }

      // (B3) A checkout-bound first charge for a workspace that has since been
      // deleted/suspended: the money is taken but nothing will ever be applied
      // (subscription.create disables the subscription) — make sure a human
      // sees it rather than only the audit row.
      if (res.via === 'checkout') {
        const ws = must(await service.from('workspaces').select('deleted_at').eq('id', workspaceId).maybeSingle(), 'read workspace').data
        if (ws?.deleted_at) {
          await alertBillingOps(service, `billing:dead-workspace-charge:${workspaceId}:${data?.reference ?? 'x'}`, 'Payment received for a deleted/suspended workspace', [
            `workspace: ${workspaceId}`, `customer email: ${customerEmail ?? '-'}`, `reference: ${data?.reference ?? '-'}`,
            `amount (subunit): ${data?.amount ?? '-'} ${data?.currency ?? ''}`, 'Refund it in the Paystack dashboard.',
          ])
        }
      }

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
      }, { redeliverable: true })
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
      // A late event for a subscription no workspace holds any more (see
      // resolve.ts isSuperseded): not an unattributable payment, nothing to do.
      if (!res.workspaceId && res.superseded) { console.log('invoice.payment_failed for an ended subscription — ignoring'); return }
      if (!res.workspaceId) { await unresolved(service, event, 'A payment failed but no workspace could be identified, so no grace period was started.'); return }
      if (res.superseded) { console.log('invoice.payment_failed for a superseded subscription — ignoring'); return }
      const workspaceId = res.workspaceId
      // FIX (Billing independent pass — B3): a workspace with NO live subscription
      // has nothing that can fail to renew. It reaches here when the subscription
      // ended (non-payment downgrade / period-end lapse clear the code but keep the
      // customer code) and Paystack delivers a late failure whose payload carries no
      // subscription code to compare. Starting a grace period on it produced a
      // dunning email + banner, then a second downgrade and "subscription ended".
      const liveCode = res.billing?.paystack_subscription_code
      if (!liveCode) { console.log('invoice.payment_failed for a workspace with no live subscription on file — ignoring'); return }

      const now = new Date().toISOString()
      // Only the FIRST failure starts the window; Paystack's later retries
      // must not push it out (see point 5 at the top of this file). Pinned to the
      // subscription we resolved: a plan switch that lands in between must not
      // have its brand-new subscription put into grace for the old one's failure.
      const started = must(await service.from('billing')
        .update({ grace_period_started_at: now, updated_at: now })
        .eq('workspace_id', workspaceId).eq('paystack_subscription_code', liveCode)
        .is('grace_period_started_at', null)
        .select('workspace_id'), 'start grace period').data
      const newlyStarted = (started || []).length > 0
      if (!newlyStarted) {
        // Either grace was already running (an ordinary Paystack retry — recorded
        // below) or the subscription was replaced under us (ignore it).
        const cur = must(await service.from('billing').select('paystack_subscription_code')
          .eq('workspace_id', workspaceId).maybeSingle(), 'read billing').data
        if (!cur || cur.paystack_subscription_code !== liveCode) {
          console.log('invoice.payment_failed: subscription changed while processing — ignoring')
          return
        }
      }

      // The dunning email goes BEFORE the audit row on purpose. If the audit write
      // fails the handler throws and Paystack redelivers; on redelivery grace is
      // already running (newlyStarted === false), so an email queued after the audit
      // would never be sent. The redelivered row is then recorded as a retry failure
      // (the history line still shows the failed charge and its amount).
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

      await audit(service, workspaceId,
        newlyStarted ? 'billing.payment_failed_grace_started' : 'billing.payment_retry_failed',
        customerEmail, { amount: fromSubunit(data?.amount), currency: data?.currency, reference: data?.reference },
        { redeliverable: true })
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
      if (!res.workspaceId && res.superseded) { console.log(`Paystack ${event.event} for an ended subscription no workspace holds — ignoring`); return }
      if (!res.workspaceId) {
        if (res.ambiguous) await unresolved(service, event, `A subscription was ${event.event === 'subscription.not_renew' ? 'set to not renew' : 'disabled'}, but the customer code matches more than one workspace — could not tell which one to update.`)
        else console.log(`Paystack ${event.event} matched no workspace — ignoring`)
        return
      }
      if (res.superseded) { console.log(`Paystack ${event.event} for a superseded subscription — ignoring (expected after a plan switch)`); return }
      // The cancel route already recorded it and logged it; don't duplicate.
      if (res.billing?.cancels_at_period_end) return

      // FIX (Billing fix round — MEDIUM): a workspace with NO live
      // subscription on file has nothing to mark as cancelling. Reaching
      // here means the subscription was already cleared on our side — most
      // commonly cron/payment-overdue's non-payment downgrade, which
      // disables the subscription on Paystack and so triggers THIS event a
      // moment later. Flagging cancels_at_period_end on the already-Solo
      // workspace made step 5 "end" it again the next day: a second
      // "subscription ended" email, a second audit row and a bogus entry in
      // Payment history.
      if (!res.billing?.paystack_subscription_code) {
        console.log(`Paystack ${event.event} for a workspace with no live subscription on file — ignoring`)
        return
      }

      // FIX (Billing fix round — LOW/MEDIUM): conditional on the subscription
      // code we just read. Between that read and this write a plan switch
      // (subscription.create) can land and replace the code; an unconditional
      // write would then flag the NEW, paid subscription as cancelling and
      // the period-end sweep would downgrade a paying customer.
      const marked = must(await service.from('billing').update({
        cancels_at_period_end: true, updated_at: new Date().toISOString(),
      }).eq('workspace_id', res.workspaceId)
        .eq('paystack_subscription_code', res.billing.paystack_subscription_code)
        .select('workspace_id'), 'mark cancellation').data
      if (!marked || marked.length === 0) {
        console.log(`Paystack ${event.event}: subscription changed while processing — ignoring`)
        return
      }

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
        // The audit row below is the 20-day dedupe key, so it is only written once somebody was actually
        // reached — a rejected send (sendEmail resolves { ok: false }, it does not throw) must not mark
        // the warning as sent and suppress the retry.
        let anySent = false
        for (const r of recipients) {
          try {
            const delivery = await sendCardExpiringEmail({
              to: r.email, name: r.name, agencyName: ws?.agency_name || 'your workspace',
              cardLabel: item?.description || [item?.brand, item?.last4 && `ending ${item.last4}`].filter(Boolean).join(' ') || 'your card',
              expiryLabel: item?.expiry_date || 'soon',
              manageUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            })
            if (delivery.ok) anySent = true
            else console.error('Card expiring email rejected:', delivery.error)
          } catch (e) { console.error('Card expiring email error:', e) }
        }
        if (recipients.length > 0 && !anySent) continue
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
      // See incidentKey's comment above `unresolved()` — same fix, same
      // reason: without it, two different customers' disputes/refunds
      // within 5 minutes of each other silently collapsed onto one alert.
      // The ops alert goes FIRST: it is the part a human must not miss, and the
      // audit write below may throw (see audit()) to get Paystack to redeliver.
      await alertBillingOps(service, `billing:incident:${event.event}:${incidentKey(data)}`, `Paystack ${event.event}`, [
        `event: ${event.event}`,
        `workspace: ${res.workspaceId ?? 'unresolved'}`,
        `customer: ${data?.customer?.email ?? '-'}`,
        `reference: ${data?.transaction_reference ?? data?.transaction?.reference ?? data?.reference ?? '-'}`,
        `status: ${data?.status ?? '-'}`,
        'Decide manually whether the workspace should be downgraded.',
      ], 5 * 60_000)
      if (res.workspaceId) {
        await audit(service, res.workspaceId, `billing.${event.event.replace(/\./g, '_')}`, data?.customer?.email, {
          amount: fromSubunit(data?.amount ?? data?.refund_amount), currency: data?.currency,
          reference: data?.transaction_reference ?? data?.transaction?.reference ?? data?.reference,
          status: data?.status, resolution: data?.resolution,
        }, { redeliverable: true })
      }
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
