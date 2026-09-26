// lib/billing/resolve.ts
//
// Decides which workspace a Paystack event is about.
//
// FIX (Billing re-pass #3 — HIGH): the webhook resolved the workspace from
// metadata.workspaceId when present and otherwise from
// users.active_workspace_id looked up by exact-case email. The first is
// browser-supplied; the second is whichever workspace the payer happens to
// have selected in the switcher RIGHT NOW. Recurring events
// (charge.success renewals, invoice.payment_failed, subscription.disable /
// not_renew) normally carry no metadata at all, so a customer with two
// workspaces would have grace started, or a cancellation applied, on the
// wrong one — and an email whose case differed from users.email made
// `.single()` fail and the event vanish silently.
//
// Order now, most authoritative first:
//   1. the subscription code  -> the billing row that owns it (unique)
//   2. the customer code      -> when exactly one billing row has it
//   3. a server-recorded pending checkout (email + plan code) — a genuine
//      fallback for the one case that can legitimately precede any billing
//      row existing at all (a brand-new customer's first charge.success,
//      which can race subscription.create either way)
// There is no active-workspace fallback. If nothing matches, the caller
// alerts a human instead of guessing.
//
// FIX (deep audit, Billing re-pass — independent redo): findPendingCheckout
// itself used to silently guess (`rows[0]`, the most-recently-CREATED
// checkout) whenever more than one candidate existed for the same
// (email, plan_code) and the browser-metadata hint didn't identify one —
// exactly the two-workspaces-on-the-same-plan scenario this file's own
// comments already call out as explicitly supported. It now reports that
// case as ambiguous instead of guessing; both 'strict' and 'prefer' below
// propagate it the same way the existing customer-code-ambiguous case
// already does, so the caller alerts a human rather than binding a real,
// paid Paystack subscription to the wrong workspace. See checkouts.ts.
//
// FIX (Billing re-pass #4 — HIGH): 'prefer' mode (charge.success) used to
// consult the checkout BEFORE subscription/customer code, unconditionally,
// for every charge — not only a first one. The header comment above already
// says checkout is meant to jump the queue only "for events that can
// legitimately precede a billing row," but the code never actually checked
// whether a billing row existed; it checked the checkout on every single
// renewal. A customer with two workspaces on the exact same plan+interval
// (this app explicitly supports one login owning several workspaces) who
// starts a checkout for workspace B within 24h of workspace A's unrelated
// subscription renewing would have A's real renewal charge attributed to
// B — B's audit log gets a payment_succeeded entry with A's amount/
// reference, and if B already has its own billing row, B's card-on-file
// gets overwritten with A's, and worse, a legitimate grace period running
// on B could be cleared by A's unrelated payment. subCode/customerCode are
// checked first now regardless of mode; checkout is only ever reached for
// 'prefer' once neither authoritative source matched anything — the actual
// "no billing row yet" case the header comment always meant.

import { findPendingCheckout, type PendingCheckout } from './checkouts'

export type ResolvedVia = 'subscription_code' | 'customer_code' | 'checkout'

export interface BillingRowLite {
  workspace_id: string
  paystack_subscription_code: string | null
  paystack_email_token: string | null
  paystack_customer_code: string | null
  current_period_end: string | null
  cancels_at_period_end: boolean | null
  grace_period_started_at: string | null
}

export interface Resolution {
  workspaceId: string | null
  via: ResolvedVia | null
  billing: BillingRowLite | null
  checkout: PendingCheckout | null
  ambiguous: boolean
  /** True when the event names a subscription other than the one on file. */
  superseded: boolean
}

const BILLING_COLS =
  'workspace_id, paystack_subscription_code, paystack_email_token, paystack_customer_code, current_period_end, cancels_at_period_end, grace_period_started_at'

export function eventSubscriptionCode(data: any): string | null {
  return data?.subscription_code || data?.subscription?.subscription_code || null
}

export async function resolveWorkspace(
  service: any,
  data: any,
  // checkout: 'strict'   -> bind ONLY to a server-recorded checkout (subscription.create)
  //           'prefer'    -> try the checkout first, then the normal lookups (a first charge.success)
  //           'off'       -> never (renewals, failures, cancellations)
  opts: { checkout?: 'strict' | 'prefer' | 'off'; planCode?: string | null } = {},
): Promise<Resolution> {
  const none: Resolution = { workspaceId: null, via: null, billing: null, checkout: null, ambiguous: false, superseded: false }
  const subCode = eventSubscriptionCode(data)
  const customerCode: string | null = data?.customer?.customer_code || null
  const email: string | null = data?.customer?.email || null

  const mode = opts.checkout ?? 'off'

  // subscription.create is the one event whose subscription code (and
  // possibly customer code) cannot be on file yet — a plan SWITCH creates a
  // brand-new subscription for a customer that already has a billing row —
  // so it must bind to the server-recorded checkout first, never to
  // "whichever row this customer code happens to match". This is the ONLY
  // mode that skips straight to checkout; 'prefer' no longer does (see the
  // file header for why).
  if (mode === 'strict') {
    if (email && opts.planCode) {
      const result = await findPendingCheckout(service, email, opts.planCode, data?.metadata?.workspaceId)
      if (result.checkout) return { ...none, workspaceId: result.checkout.workspace_id, via: 'checkout', checkout: result.checkout }
      // FIX (deep audit, Billing re-pass — independent redo): see
      // checkouts.ts's findPendingCheckout header. More than one candidate
      // and no way to tell them apart must not fall through to `return none`
      // silently — that's indistinguishable from "nothing pending at all"
      // to the caller, when in fact we know EXACTLY the risk: two workspaces
      // both mid-checkout for the same plan, and guessing wrong means
      // binding a paid subscription to the wrong one.
      if (result.ambiguous) return { ...none, ambiguous: true }
    }
    return none
  }

  if (subCode) {
    const { data: row, error } = await service.from('billing').select(BILLING_COLS)
      .eq('paystack_subscription_code', subCode).maybeSingle()
    if (error) throw new Error(`billing lookup by subscription code failed: ${error.message}`)
    if (row) return { ...none, workspaceId: row.workspace_id, via: 'subscription_code', billing: row }
  }

  if (customerCode) {
    const { data: rows, error } = await service.from('billing').select(BILLING_COLS)
      .eq('paystack_customer_code', customerCode).limit(5)
    if (error) throw new Error(`billing lookup by customer code failed: ${error.message}`)
    if (rows && rows.length === 1) {
      const row = rows[0]
      // The event names a subscription, it isn't the one on file: it belongs
      // to a subscription this workspace has already moved on from.
      const superseded = !!(subCode && row.paystack_subscription_code && row.paystack_subscription_code !== subCode)
      return { ...none, workspaceId: row.workspace_id, via: 'customer_code', billing: row, superseded }
    }
    if (rows && rows.length > 1) return { ...none, ambiguous: true }
  }

  // Genuine fallback: neither authoritative source matched anything, so
  // there is no billing row yet — a first-ever charge for a brand-new
  // customer is the only realistic way to land here for 'prefer'.
  if (mode === 'prefer' && email && opts.planCode) {
    const result = await findPendingCheckout(service, email, opts.planCode, data?.metadata?.workspaceId)
    if (result.checkout) return { ...none, workspaceId: result.checkout.workspace_id, via: 'checkout', checkout: result.checkout }
    if (result.ambiguous) return { ...none, ambiguous: true }
  }

  return none
}
