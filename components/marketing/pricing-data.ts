// Plan data and the small "scope leak" calculator on the homepage. Plain TS (no JSX / CSS) so tests can import it and pin
// it to the real source of truth: seats/projects to PLAN_LIMITS, features to PLAN_FEATURES, prices to LIST_PRICES_USD
// (see tests/homepage-rebrand.test.ts).
//
// FIX (Billing / trial-end audit — MEDIUM): this file used to carry its OWN model — different defaults (22% creep, 72%
// recovery, 2 seats, 4 active projects), monthly price x 12 whatever the billing toggle said, plan fit on seats and projects
// only, and clamps (creep 0-40%, recovery 5-80%) the real calculator does not have. The same "12 projects x $5,000" read as
// "Starter, +$8,316 a year" here and "Solo, +$3,690" in the signed-in calculator. It now delegates to computeRoi (the model
// /calculator and /plan-calculator run), starts from the same defaults (HOME_CALC_DEFAULTS <- BLANK_INPUTS) and hands its
// numbers to /calculator through the URL (lib/billing/roi-url.ts), so one set of inputs gives one answer everywhere.

import { BLANK_INPUTS, computeRoi } from '@/lib/billing/roi-model'

export type HomePlan = {
  key: 'solo' | 'starter' | 'pro' | 'agency'
  name: string
  monthly: number
  annual: number
  seats: number
  /** null = unlimited, same as PLAN_LIMITS. */
  projects: number | null
  fullHistory: boolean
  customRoles: boolean
  /** One-line payback, based on the average change order the page quotes (~$1,450). */
  pays: string
}

export const HOME_PLANS: HomePlan[] = [
  { key: 'solo', name: 'Solo', monthly: 39, annual: 390, seats: 1, projects: 2, fullHistory: false, customRoles: false, pays: 'One average change order (~$1,450) covers about three years.' },
  { key: 'starter', name: 'Starter', monthly: 99, annual: 990, seats: 2, projects: 5, fullHistory: true, customRoles: false, pays: 'One average change order (~$1,450) covers over a year.' },
  { key: 'pro', name: 'Pro', monthly: 249, annual: 2490, seats: 4, projects: null, fullHistory: true, customRoles: true, pays: 'One average change order (~$1,450) covers almost six months.' },
  { key: 'agency', name: 'Agency', monthly: 399, annual: 3990, seats: 10, projects: null, fullHistory: true, customRoles: true, pays: 'One average change order (~$1,450) covers about three and a half months.' },
]

export type CalcInputs = {
  projectsPerYear: number
  avgProjectValue: number
  /** % of work outside the SOW, 0-40 */
  creepPct: number
  /** % of that work you would recover, 5-80 */
  recoverPct: number
  seats: number
  activeProjects: number
  /** Which price the plan cost uses; the full calculator's default (annual) when omitted. */
  interval?: 'monthly' | 'annual'
  needsCustomRoles?: boolean
  needsFullHistory?: boolean
}

// Same ranges as the full calculator's normalizeInputs (lib/billing/roi-model.ts), so a number means the same thing in both.
export const CALC_BOUNDS = {
  projectsPerYear: { min: 0, max: 10_000 },
  avgProjectValue: { min: 0, max: 1_000_000_000 },
  creepPct: { min: 0, max: 100 },
  recoverPct: { min: 0, max: 100 },
  seats: { min: 1, max: 1000 },
  activeProjects: { min: 0, max: 100_000 },
} as const

/** What the homepage form starts with — the full calculator's own blank defaults, so both open on the same numbers. */
export const HOME_CALC_DEFAULTS = {
  projectsPerYear: BLANK_INPUTS.projectsPerYear,
  avgProjectValue: BLANK_INPUTS.avgProjectValue,
  creepPct: BLANK_INPUTS.creepPct,
  recoverPct: Math.round(BLANK_INPUTS.recoveryRate * 100),
  seats: BLANK_INPUTS.seatsNeeded,
  activeProjects: BLANK_INPUTS.activeProjectsNeeded,
  annual: BLANK_INPUTS.interval === 'annual',
} as const

/** Parse a form field and clamp it into [min, max]. A blank / non-numeric field counts as the minimum rather than a hidden default. */
export function clampField(raw: string, min: number, max: number): number {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** Smallest plan whose seat and project caps both cover the need, or null when none does (more than 10 seats). */
export function fittingPlan(seats: number, activeProjects: number, needs: { customRoles?: boolean; fullHistory?: boolean } = {}): HomePlan | null {
  return HOME_PLANS.find((p) =>
    seats <= p.seats && (p.projects === null || activeProjects <= p.projects) &&
    (!needs.customRoles || p.customRoles) && (!needs.fullHistory || p.fullHistory)) ?? null
}

export type CalcResult = {
  leaked: number
  recoverable: number
  plan: HomePlan | null
  /** Plan cost over 12 months at the chosen billing interval's price. */
  annualCost: number | null
  net: number | null
  /** Weeks of recovered scope needed to pay for the plan; null when it never does. */
  paybackWeeks: number | null
  worthIt: boolean
}

export function calcScopeLeak(i: CalcInputs): CalcResult {
  const roi = computeRoi({
    projectsPerYear: i.projectsPerYear, avgProjectValue: i.avgProjectValue, creepPct: i.creepPct,
    grantedFreeValue: 0, recoveryRate: i.recoverPct / 100,
    seatsNeeded: i.seats, activeProjectsNeeded: i.activeProjects,
    needsCustomRoles: !!i.needsCustomRoles, needsFullHistory: !!i.needsFullHistory,
    interval: i.interval ?? BLANK_INPUTS.interval, currency: 'USD', fxToUsd: null,
  })
  const { leaked, recoverable } = roi
  const rec = roi.recommended
  const plan = rec ? HOME_PLANS.find((p) => p.key === rec.plan) ?? null : null
  if (!rec || !plan || rec.net === null) return { leaked, recoverable, plan: null, annualCost: null, net: null, paybackWeeks: null, worthIt: false }
  const annualCost = rec.annualCostUsd
  const net = rec.net
  const worthIt = net > 0 && recoverable > 0
  const paybackWeeks = worthIt ? Math.max(1, Math.ceil((annualCost / recoverable) * 52)) : null
  return { leaked, recoverable, plan, annualCost, net, paybackWeeks, worthIt }
}
