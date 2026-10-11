// Plan data and the small "scope leak" model behind the homepage pricing calculator. Plain TS (no JSX / CSS) so tests can
// import it and pin it to the real source of truth: seats/projects to PLAN_LIMITS, features to PLAN_FEATURES, prices to
// LIST_PRICES_USD (see tests/homepage-rebrand.test.ts). The full model lives at /calculator.

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
}

export const CALC_BOUNDS = {
  projectsPerYear: { min: 1, max: 500 },
  avgProjectValue: { min: 0, max: 10_000_000 },
  creepPct: { min: 0, max: 40 },
  recoverPct: { min: 5, max: 80 },
  seats: { min: 1, max: 50 },
  activeProjects: { min: 1, max: 1000 },
} as const

/** Parse a form field and clamp it into [min, max]. A blank / non-numeric field counts as the minimum rather than a hidden default. */
export function clampField(raw: string, min: number, max: number): number {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** Smallest plan whose seat and project caps both cover the need, or null when none does (more than 10 seats). */
export function fittingPlan(seats: number, activeProjects: number): HomePlan | null {
  return HOME_PLANS.find((p) => seats <= p.seats && (p.projects === null || activeProjects <= p.projects)) ?? null
}

export type CalcResult = {
  leaked: number
  recoverable: number
  plan: HomePlan | null
  /** Plan cost over 12 months at the monthly price. */
  annualCost: number | null
  net: number | null
  /** Weeks of recovered scope needed to pay for the plan; null when it never does. */
  paybackWeeks: number | null
  worthIt: boolean
}

export function calcScopeLeak(i: CalcInputs): CalcResult {
  const leaked = i.projectsPerYear * i.avgProjectValue * (i.creepPct / 100)
  const recoverable = leaked * (i.recoverPct / 100)
  const plan = fittingPlan(i.seats, i.activeProjects)
  if (!plan) return { leaked, recoverable, plan: null, annualCost: null, net: null, paybackWeeks: null, worthIt: false }
  const annualCost = plan.monthly * 12
  const net = recoverable - annualCost
  const worthIt = net > 0 && recoverable > 0
  const paybackWeeks = worthIt ? Math.max(1, Math.ceil((annualCost / recoverable) * 52)) : null
  return { leaked, recoverable, plan, annualCost, net, paybackWeeks, worthIt }
}
