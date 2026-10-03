// lib/billing/list-prices.ts
//
// List prices in USD, used ONLY for the platform admin's MRR estimate (app/(admin)/admin/finance). Paystack is the
// source of truth for what a customer is actually charged; the amounts the webhook records on each charge are what
// the Finance page reports as "collected". These values mirror the plan cards in components/settings/SettingsClient.tsx
// — tests/admin-panel-audit.test.ts fails if the two ever drift apart.
import type { PaidPlanKey, BillingInterval } from '@/lib/billing/plans'

export const LIST_PRICES_USD: Record<PaidPlanKey, Record<BillingInterval, number>> = {
  solo:    { monthly: 39,  annual: 390 },
  starter: { monthly: 99,  annual: 990 },
  pro:     { monthly: 249, annual: 2490 },
  agency:  { monthly: 399, annual: 3990 },
}

/** Monthly-recurring value of one subscription at list price (annual plans are spread over 12 months). */
export function monthlyListPriceUsd(plan: string, interval: string | null | undefined): number | null {
  const prices = (LIST_PRICES_USD as Record<string, Record<BillingInterval, number> | undefined>)[plan]
  if (!prices) return null
  return interval === 'annual' ? prices.annual / 12 : prices.monthly
}
