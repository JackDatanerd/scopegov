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
//   3. a server-recorded pending checkout (email + plan code) — consulted
//      FIRST for the events that can legitimately precede a billing row
//      (subscription.create, a first charge.success)
// There is no active-workspace fallback. If nothing matches, the caller
// alerts a human instead of guessing.

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

  // subscription.create is the one event whose subscription code (and
  // possibly customer code) cannot be on file yet — a plan SWITCH creates a
  // brand-new subscription for a customer that already has a billing row —
  // so it must bind to the server-recorded checkout first, never to
  // "whichever row this customer code happens to match".
  const mode = opts.checkout ?? 'off'
  if ((mode === 'strict' || mode === 'prefer') && email && opts.planCode) {
    const checkout = await findPendingCheckout(service, email, opts.planCode, data?.metadata?.workspaceId)
    if (checkout) return { ...none, workspaceId: checkout.workspace_id, via: 'checkout', checkout }
  }
  if (mode === 'strict') return none

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

  return none
}
