// lib/billing/recover-checkout.ts
//
// FIX (Billing — payment stuck on "Payment received — confirming your plan"):
// the plan changes ONLY on the Paystack webhook (BUG-054), and nothing could notice a webhook that never came. The
// customer paid, the popup said so, the Billing tab polled for 90 seconds and reloaded into the old plan; the money
// was taken and the workspace was never touched.
//
// This replays what the webhook would have done, but from what Paystack itself tells the server when asked:
//   1. verify the transaction by the reference the popup handed back (must be a successful charge);
//   2. require that it belongs to a checkout THIS server recorded for THIS workspace (same email + plan code, not
//      consumed, not expired) — the reference alone never grants anything, and a reference from another workspace's
//      checkout cannot be claimed here;
//   3. find the subscription Paystack created for that customer + plan;
//   4. feed the same two events the webhook handles (charge.success, then subscription.create) through the very
//      same handler (lib/billing/webhook-handler.ts), so a recovered payment is applied exactly like a delivered one.
//
// It is safe to run alongside the real webhook: subscription.create is idempotent by subscription code (a second
// application finds the code already on file and stops) and the charge audit row dedupes by reference.

import { verifyPaystackTransaction, listPaystackSubscriptionsForCustomer } from '@/lib/integrations/paystack'
import { CHECKOUT_TTL_MS } from '@/lib/billing/checkouts'
import { handleEvent } from '@/lib/billing/webhook-handler'
import { claimWebhookEvent, completeWebhookEvent, releaseWebhookEvent } from '@/lib/billing/webhook-claims'
import { alertBillingOps } from '@/lib/billing/ops-alert'

export type RecoverState =
  | 'applied'                 // the plan is now active (recovered, or already applied by the webhook)
  | 'payment_not_successful'  // Paystack does not (yet) report this payment as successful
  | 'not_ours'                // the reference does not belong to a checkout of this workspace
  | 'subscription_pending'    // paid, but Paystack has not created the subscription yet — ask again shortly
  | 'unavailable'             // Paystack could not be read right now

export interface RecoverResult { state: RecoverState; detail?: string }

const REF_RE = /^[A-Za-z0-9._=\-]{4,100}$/

export async function recoverPaidCheckout(
  service: any, workspaceId: string, reference: unknown,
): Promise<RecoverResult> {
  if (typeof reference !== 'string' || !REF_RE.test(reference)) return { state: 'not_ours', detail: 'Invalid reference' }

  const v = await verifyPaystackTransaction(reference)
  if (!v.ok) return v.notFound ? { state: 'not_ours', detail: 'Paystack does not know this reference' } : { state: 'unavailable', detail: v.error }
  const tx = v.tx
  if (tx.status !== 'success') return { state: 'payment_not_successful', detail: tx.status ?? undefined }

  const email = (tx.email || '').trim().toLowerCase()
  if (!email || !tx.planCode) return { state: 'not_ours', detail: 'The payment is not a subscription payment' }

  // The popup's metadata names the workspace that opened it; if it names another one this is not ours.
  const metaWs = typeof tx.metadata?.workspaceId === 'string' ? tx.metadata.workspaceId : null
  if (metaWs && metaWs !== workspaceId) return { state: 'not_ours', detail: 'Payment belongs to another workspace' }

  const since = new Date(Date.now() - CHECKOUT_TTL_MS).toISOString()
  const { data: checkouts, error: coErr } = await service.from('billing_checkouts')
    .select('id').eq('workspace_id', workspaceId).eq('email', email).eq('plan_code', tx.planCode)
    .is('consumed_at', null).gte('created_at', since).limit(1)
  if (coErr) return { state: 'unavailable', detail: coErr.message }
  if (!checkouts || checkouts.length === 0) {
    // No open checkout: either the webhook already consumed it (the plan is applied) or this was never ours.
    const { data: b } = await service.from('billing').select('paystack_subscription_code').eq('workspace_id', workspaceId).maybeSingle()
    return b?.paystack_subscription_code ? { state: 'applied', detail: 'Already applied' } : { state: 'not_ours', detail: 'No open checkout for this payment' }
  }

  if (tx.customerId === null || tx.customerId === undefined) return { state: 'unavailable', detail: 'Paystack did not return the customer' }
  const list = await listPaystackSubscriptionsForCustomer(tx.customerId)
  if (!list.ok) return { state: 'unavailable', detail: list.error }
  const sub = list.subs.find(s => s.planCode === tx.planCode && (s.status === 'active' || s.status === 'non-renewing' || s.status === 'attention'))
  if (!sub) return { state: 'subscription_pending' }

  const metadata = { ...(tx.metadata || {}), workspaceId }
  const key = `recover:${sub.subscriptionCode}`
  const claim = await claimWebhookEvent(service, key)
  if (claim.status === 'duplicate') return { state: 'applied', detail: 'Already recovered' }
  if (claim.status === 'in_progress') return { state: 'subscription_pending', detail: 'Another confirmation is in progress' }

  try {
    await handleEvent(service, { event: 'charge.success', data: {
      reference: tx.reference, amount: tx.amount, currency: tx.currency, paid_at: tx.paidAt, channel: tx.channel,
      customer: { email, customer_code: tx.customerCode }, plan: { plan_code: tx.planCode },
      authorization: tx.authorization, metadata,
    } })
    await handleEvent(service, { event: 'subscription.create', data: {
      subscription_code: sub.subscriptionCode, email_token: sub.emailToken, next_payment_date: sub.nextPaymentDate,
      plan: { plan_code: tx.planCode }, customer: { email, customer_code: tx.customerCode },
      authorization: tx.authorization, metadata,
    } })
    await completeWebhookEvent(service, key, claim.claimedAt!)
  } catch (e) {
    await releaseWebhookEvent(service, key, claim.claimedAt!)
    await alertBillingOps(service, `billing:recover-failed:${workspaceId}:${sub.subscriptionCode}`, 'Recovering a paid checkout failed', [
      `workspace: ${workspaceId}`, `subscription: ${sub.subscriptionCode}`, `reference: ${reference}`,
      `error: ${e instanceof Error ? e.message : String(e)}`,
      'The customer has paid but the plan was not applied; the in-app recovery will retry on their next confirmation.',
    ]).catch(() => {})
    return { state: 'unavailable', detail: 'Could not apply the plan' }
  }
  return { state: 'applied' }
}
