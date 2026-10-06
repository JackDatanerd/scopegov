// lib/billing/roi-model.ts
//
// Scope-loss calculator — the pure model. No I/O, no React, no clock: the same function runs in the signed-in
// calculator (prefilled with the workspace's own numbers), the public /calculator page (blank), and the tests.
//
// What it answers: "given what I lose to scope creep, which plan fits me, and does it pay for itself?"
//
// Rules the model keeps (they are what makes the number credible, so they are tested):
//   1. Leakage is the LARGER of the user's creep estimate and the value they measurably granted for free
//      (exceptions). Granted-free work is a subset of creep, so adding the two would count it twice.
//   2. Recoverable = leakage × recovery rate. The rate defaults to 25% (DEFAULT_RECOVERY_RATE) and is always editable.
//   3. A plan is recommended on FIT first (seats, simultaneously active projects, features), price second: the cheapest
//      plan that fits wins, whatever the money says. If even that plan loses money, the verdict says so.
//   4. Plan prices are USD (LIST_PRICES_USD). A workspace in another currency must supply an exchange rate; without it
//      no net figure is produced, so two currencies are never subtracted from each other.
//   5. Everything is an ESTIMATE from the inputs shown. The model never claims a guaranteed return.

import { LIST_PRICES_USD } from '@/lib/billing/list-prices'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { PAID_PLAN_KEYS, type PaidPlanKey, type BillingInterval } from '@/lib/billing/plans'

export const DEFAULT_RECOVERY_RATE = 0.25
/** A workspace's own flag→change-order rate is only offered as an alternative with at least this many counted flags. */
export const MIN_FLAGS_FOR_OWN_RATE = 5

/**
 * What each paid plan includes beyond its seat/project caps. Mirrors the public pricing table
 * (components/marketing/MarketingHome.tsx PRICING_ROWS) and the enforcement in app/api/team/roles/route.ts and
 * app/api/invoices/export/route.ts — tests/scope-loss-calculator.test.ts fails if they drift apart.
 */
export const PLAN_FEATURES: Record<PaidPlanKey, { customRoles: boolean; fullHistory: boolean }> = {
  solo:    { customRoles: false, fullHistory: false },
  starter: { customRoles: false, fullHistory: true },
  pro:     { customRoles: true,  fullHistory: true },
  agency:  { customRoles: true,  fullHistory: true },
}

export interface RoiInputs {
  /** Projects started per year. */
  projectsPerYear: number
  /** Average contract value of one project, in the user's currency. */
  avgProjectValue: number
  /** The user's estimate of scope creep as a percentage of project value (0–100). */
  creepPct: number
  /** Value the workspace measurably granted for free over the last 12 months (exceptions log); 0 when unknown. */
  grantedFreeValue: number
  /** Share of leaked value the user expects to recover (0–1). */
  recoveryRate: number
  /** People who need a seat. */
  seatsNeeded: number
  /** Projects active at the same time. */
  activeProjectsNeeded: number
  needsCustomRoles: boolean
  needsFullHistory: boolean
  interval: BillingInterval
  /** ISO currency of the monetary inputs above. */
  currency: string
  /** 1 unit of `currency` in USD. Ignored for USD; required (> 0) for any other currency to get a net figure. */
  fxToUsd: number | null
}

export const BLANK_INPUTS: RoiInputs = {
  projectsPerYear: 12,
  avgProjectValue: 5000,
  creepPct: 10,
  grantedFreeValue: 0,
  recoveryRate: DEFAULT_RECOVERY_RATE,
  seatsNeeded: 1,
  activeProjectsNeeded: 2,
  needsCustomRoles: false,
  needsFullHistory: false,
  interval: 'monthly',
  currency: 'USD',
  fxToUsd: null,
}

const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/** Clamp every field to a sane range so a typo (or a hostile URL) can never produce NaN, Infinity or a negative figure. */
export function normalizeInputs(raw: Partial<RoiInputs> | null | undefined): RoiInputs {
  const r = raw || {}
  const currency = typeof r.currency === 'string' && /^[A-Za-z]{3}$/.test(r.currency.trim()) ? r.currency.trim().toUpperCase() : 'USD'
  const fx = r.fxToUsd === null || r.fxToUsd === undefined ? null : num(r.fxToUsd, 0, 1e6, 0)
  return {
    projectsPerYear: Math.floor(num(r.projectsPerYear, 0, 10_000, BLANK_INPUTS.projectsPerYear)),
    avgProjectValue: num(r.avgProjectValue, 0, 1e9, BLANK_INPUTS.avgProjectValue),
    creepPct: num(r.creepPct, 0, 100, BLANK_INPUTS.creepPct),
    grantedFreeValue: num(r.grantedFreeValue, 0, 1e12, 0),
    recoveryRate: num(r.recoveryRate, 0, 1, DEFAULT_RECOVERY_RATE),
    seatsNeeded: Math.max(1, Math.floor(num(r.seatsNeeded, 1, 1000, 1))),
    activeProjectsNeeded: Math.floor(num(r.activeProjectsNeeded, 0, 100_000, 0)),
    needsCustomRoles: !!r.needsCustomRoles,
    needsFullHistory: !!r.needsFullHistory,
    interval: r.interval === 'annual' ? 'annual' : 'monthly',
    currency,
    fxToUsd: currency === 'USD' ? null : (fx && fx > 0 ? fx : null),
  }
}

export interface PlanFit {
  plan: PaidPlanKey
  fits: boolean
  /** Why it does not fit, in plain words (empty when it fits). */
  reasons: string[]
  /** Annual price in USD at the chosen interval. */
  annualCostUsd: number
  /** Annual price in the user's currency; null when no exchange rate is available. */
  annualCost: number | null
  /** recoverable − annualCost, user's currency; null when no exchange rate is available. */
  net: number | null
  /** Months of recovered value needed to cover one year's price; null when nothing is recoverable or no rate. */
  paybackMonths: number | null
}

export type Verdict =
  | 'worth_it'      // the recommended plan pays for itself within the year
  | 'not_yet'       // it fits, but at these numbers it costs more than it recovers
  | 'needs_fx'      // non-USD and no exchange rate yet
  | 'no_plan_fits'  // needs exceed every plan

export interface RoiResult {
  inputs: RoiInputs
  /** Annual value of creep, from the user's estimate. */
  estimatedCreep: number
  /** Annual value granted free, measured. */
  grantedFree: number
  /** The leakage figure used: max(estimatedCreep, grantedFree). */
  leaked: number
  /** Which of the two the leakage figure came from. */
  leakedFrom: 'estimate' | 'measured'
  recoverable: number
  plans: PlanFit[]
  recommended: PlanFit | null
  verdict: Verdict
}

function annualCostUsd(plan: PaidPlanKey, interval: BillingInterval): number {
  const p = LIST_PRICES_USD[plan]
  return interval === 'annual' ? p.annual : p.monthly * 12
}

function fitReasons(plan: PaidPlanKey, i: RoiInputs): string[] {
  const limits = PLAN_LIMITS[plan]
  const out: string[] = []
  if (i.seatsNeeded > limits.seats) out.push(`${limits.seats} seat${limits.seats === 1 ? '' : 's'} (you need ${i.seatsNeeded})`)
  if (limits.projects !== null && i.activeProjectsNeeded > limits.projects) out.push(`${limits.projects} active projects (you need ${i.activeProjectsNeeded})`)
  if (i.needsCustomRoles && !PLAN_FEATURES[plan].customRoles) out.push('no custom roles')
  if (i.needsFullHistory && !PLAN_FEATURES[plan].fullHistory) out.push('only the last 10 invoices and SOWs, no export')
  return out
}

export function computeRoi(raw: Partial<RoiInputs> | null | undefined): RoiResult {
  const inputs = normalizeInputs(raw)
  const estimatedCreep = inputs.projectsPerYear * inputs.avgProjectValue * (inputs.creepPct / 100)
  const grantedFree = inputs.grantedFreeValue
  const leakedFrom: 'estimate' | 'measured' = grantedFree > estimatedCreep ? 'measured' : 'estimate'
  const leaked = Math.max(estimatedCreep, grantedFree)
  const recoverable = leaked * inputs.recoveryRate

  const rate = inputs.currency === 'USD' ? 1 : inputs.fxToUsd // USD per unit of the user's currency
  const plans: PlanFit[] = PAID_PLAN_KEYS.map(plan => {
    const reasons = fitReasons(plan, inputs)
    const usd = annualCostUsd(plan, inputs.interval)
    const cost = rate ? usd / rate : null
    const net = cost === null ? null : recoverable - cost
    const paybackMonths = cost !== null && recoverable > 0 ? (cost / recoverable) * 12 : null
    return { plan, fits: reasons.length === 0, reasons, annualCostUsd: usd, annualCost: cost, net, paybackMonths }
  })

  const recommended = plans.find(p => p.fits) ?? null
  let verdict: Verdict
  if (!recommended) verdict = 'no_plan_fits'
  else if (recommended.net === null) verdict = 'needs_fx'
  else verdict = recommended.net > 0 ? 'worth_it' : 'not_yet'

  return { inputs, estimatedCreep, grantedFree, leaked, leakedFrom, recoverable, plans, recommended, verdict }
}

/** The workspace's own flag→change-order conversion rate, or null when there are too few flags to mean anything. */
export function ownRecoveryRate(totalFlags: number, convertedToCo: number): number | null {
  if (!Number.isFinite(totalFlags) || totalFlags < MIN_FLAGS_FOR_OWN_RATE) return null
  const r = convertedToCo / totalFlags
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : null
}
