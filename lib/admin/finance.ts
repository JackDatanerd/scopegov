// lib/admin/finance.ts — pure shaping/estimation for the platform admin Finance page (unit-tested).
import { monthlyListPriceUsd } from '@/lib/billing/list-prices'

export type FinanceKind = 'payment' | 'refund' | 'failed' | 'dispute'
export interface FinanceRow { month: string; currency: string; kind: FinanceKind; n: number; total: number }
export interface Bucket { n: number; total: number }
export type MonthBuckets = Record<FinanceKind, Bucket>

const empty = (): MonthBuckets => ({
  payment: { n: 0, total: 0 }, refund: { n: 0, total: 0 }, failed: { n: 0, total: 0 }, dispute: { n: 0, total: 0 },
})

/** admin_finance_summary rows -> { currency -> { 'YYYY-MM-01' -> buckets } }. Currencies are never merged. */
export function shapeFinance(raw: Array<Record<string, any>> | null | undefined): Record<string, Record<string, MonthBuckets>> {
  const out: Record<string, Record<string, MonthBuckets>> = {}
  for (const r of raw || []) {
    const kind = r.kind as FinanceKind
    if (!['payment', 'refund', 'failed', 'dispute'].includes(kind)) continue
    const cur = String(r.currency || '?')
    const month = String(r.month).slice(0, 10)
    const b = ((out[cur] ??= {})[month] ??= empty())
    b[kind].n += Number(r.n) || 0
    b[kind].total += Number(r.total) || 0
  }
  return out
}

export interface BillingMrrRow {
  plan_tier: string | null
  plan_interval: string | null
  paystack_subscription_code: string | null
  cancels_at_period_end: boolean | null
  grace_period_started_at: string | null
}

export interface MrrEstimate {
  subscriptions: number
  mrrUsd: number
  /** subscriptions whose latest charge failed (grace period running) */
  atRiskCount: number; atRiskUsd: number
  /** subscriptions set to end at the period end */
  cancellingCount: number; cancellingUsd: number
  /** subscriptions with no recorded interval — priced as monthly */
  assumedMonthly: number
}

/** Estimated MRR at list price over active workspaces that hold a Paystack subscription on a paid plan. */
export function estimateMrr(rows: BillingMrrRow[]): MrrEstimate {
  const e: MrrEstimate = { subscriptions: 0, mrrUsd: 0, atRiskCount: 0, atRiskUsd: 0, cancellingCount: 0, cancellingUsd: 0, assumedMonthly: 0 }
  for (const r of rows) {
    if (!r.paystack_subscription_code || !r.plan_tier) continue
    const v = monthlyListPriceUsd(r.plan_tier, r.plan_interval)
    if (v == null) continue // trial / unknown tier: not recurring revenue
    e.subscriptions++
    e.mrrUsd += v
    if (r.plan_interval !== 'annual' && r.plan_interval !== 'monthly') e.assumedMonthly++
    if (r.grace_period_started_at) { e.atRiskCount++; e.atRiskUsd += v }
    if (r.cancels_at_period_end) { e.cancellingCount++; e.cancellingUsd += v }
  }
  return e
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function fmtMonth(isoDate: string): string {
  const [y, m] = isoDate.split('-')
  return `${MONTHS[(Number(m) || 1) - 1]} ${y}`
}

export function fmtMoney(amount: number, currency: string): string {
  if (!currency || currency === '?') return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

/** First day of the current UTC month, matching the SQL function's month bucket. */
export function currentMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}
