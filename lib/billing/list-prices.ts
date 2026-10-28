// lib/billing/list-prices.ts
//
// List prices in USD, used ONLY for the platform admin's MRR estimate (app/(admin)/admin/finance). Paystack is the
// source of truth for what a customer is actually charged; the amounts the webhook records on each charge are what
// the Finance page reports as "collected". These values now come from the one plan table in lib/billing/entitlements.ts, the
// same table the plan cards read.
import type { PaidPlanKey, BillingInterval } from '@/lib/billing/plans'
import { PAID_PLAN_ORDER, PLAN_ENTITLEMENTS } from '@/lib/billing/entitlements'

export const LIST_PRICES_USD: Record<PaidPlanKey, Record<BillingInterval, number>> = Object.fromEntries(
  PAID_PLAN_ORDER.map(p => [p, { monthly: PLAN_ENTITLEMENTS[p].prices!.monthly, annual: PLAN_ENTITLEMENTS[p].prices!.annual }]),
) as Record<PaidPlanKey, Record<BillingInterval, number>>

/** Monthly-recurring value of one subscription at list price (annual plans are spread over 12 months). */
export function monthlyListPriceUsd(plan: string, interval: string | null | undefined): number | null {
  const prices = (LIST_PRICES_USD as Record<string, Record<BillingInterval, number> | undefined>)[plan]
  if (!prices) return null
  return interval === 'annual' ? prices.annual / 12 : prices.monthly
}
