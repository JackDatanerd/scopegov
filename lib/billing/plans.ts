// lib/billing/plans.ts
//
// Pure plan / interval / plan-code logic shared by api/billing/upgrade, the
// Paystack webhook and the reconciliation cron.
//
// FIX (Billing re-pass #3): api/billing/upgrade built its env-var name with
// `planKey.toUpperCase()` but looked seat/project limits up with the RAW
// planKey in PLAN_LIMITS (lowercase keys). Sending planKey "SOLO" therefore
// resolved a real plan code while `PLAN_LIMITS["SOLO"]` was undefined — both
// downgrade guards (seat count, project count) were skipped entirely. A
// non-string planKey/interval also threw a TypeError whose message leaked
// into the 500 response. Everything is now parsed once, against an
// allowlist, and normalised before any lookup.

import type { Plan } from '@/lib/supabase/types'

export const PAID_PLAN_KEYS = ['solo', 'starter', 'pro', 'agency'] as const
export type PaidPlanKey = (typeof PAID_PLAN_KEYS)[number]
export const BILLING_INTERVALS = ['monthly', 'annual'] as const
export type BillingInterval = (typeof BILLING_INTERVALS)[number]

// One source of truth for the grace window (it used to be a literal 5 in the
// webhook, the UI banner and the cron, which could drift independently).
export const GRACE_DAYS = 5
export const GRACE_REMINDER_DAYS_LEFT = 3

// Length of the free trial a new workspace starts with (create_workspace_atomic: now() + 14 days). An admin can
// extend a trial well past this (extend-trial allows up to 365 days), so never assume `daysLeft <= TRIAL_DAYS`.
export const TRIAL_DAYS = 14

/**
 * Fill of the Sidebar's trial progress bar (0-100). Divides by the longer of the standard trial and the days left,
 * so an admin-extended trial (e.g. 60 days left) shows a full bar instead of overflowing past 100%, and a normal
 * trial still drains from 14/14 to 0.
 */
export function trialBarPercent(daysLeft: number): number {
  if (!Number.isFinite(daysLeft) || daysLeft <= 0) return 0
  return Math.round((daysLeft / Math.max(TRIAL_DAYS, daysLeft)) * 100)
}

// Paystack subscription statuses that mean "this subscription will not charge again". One list for the
// reconciliation cron and billing/cancel's ambiguous-failure check (Billing independent pass 10 — B2), so the
// two cannot drift apart.
export const UPSTREAM_ENDED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'non-renewing', 'completed', 'complete'])

type Env = Record<string, string | undefined>

export type PlanRequest =
  | { ok: true; planKey: PaidPlanKey; interval: BillingInterval; envKey: string }
  | { ok: false; error: string }

export function parsePlanRequest(rawPlan: unknown, rawInterval: unknown): PlanRequest {
  if (typeof rawPlan !== 'string' || !rawPlan.trim()) return { ok: false, error: 'planKey required' }
  const planKey = rawPlan.trim().toLowerCase()
  if (!(PAID_PLAN_KEYS as readonly string[]).includes(planKey)) return { ok: false, error: 'Unknown plan' }
  const intervalRaw = rawInterval === undefined || rawInterval === null || rawInterval === '' ? 'monthly' : rawInterval
  if (typeof intervalRaw !== 'string') return { ok: false, error: 'Unknown billing interval' }
  const interval = intervalRaw.trim().toLowerCase()
  if (!(BILLING_INTERVALS as readonly string[]).includes(interval)) return { ok: false, error: 'Unknown billing interval' }
  return {
    ok: true,
    planKey: planKey as PaidPlanKey,
    interval: interval as BillingInterval,
    envKey: `PAYSTACK_PLAN_${planKey.toUpperCase()}_${interval.toUpperCase()}`,
  }
}

export function planCodeFor(planKey: PaidPlanKey, interval: BillingInterval, env: Env = process.env): string | null {
  return env[`PAYSTACK_PLAN_${planKey.toUpperCase()}_${interval.toUpperCase()}`] || null
}

function eachPlanCode(env: Env): Array<{ code: string; tier: PaidPlanKey; interval: BillingInterval }> {
  const out: Array<{ code: string; tier: PaidPlanKey; interval: BillingInterval }> = []
  for (const tier of PAID_PLAN_KEYS) for (const interval of BILLING_INTERVALS) {
    const code = planCodeFor(tier, interval, env)
    if (code) out.push({ code, tier, interval })
  }
  return out
}

// Exact-match reverse lookup. Unset env vars are skipped — the old
// implementation keyed a plain object on `process.env.X || ''`, so an
// unconfigured plan collapsed to the '' key and an empty plan code could
// resolve to whichever tier was written last.
export function planCodeToTier(planCode: string | null | undefined, env: Env = process.env): PaidPlanKey | null {
  if (!planCode) return null
  return eachPlanCode(env).find(p => p.code === planCode)?.tier ?? null
}

export function planCodeToInterval(planCode: string | null | undefined, env: Env = process.env): BillingInterval | null {
  if (!planCode) return null
  return eachPlanCode(env).find(p => p.code === planCode)?.interval ?? null
}

/** Paystack reports amounts in the currency's smallest subunit. */
export function fromSubunit(amount: unknown): number | undefined {
  return typeof amount === 'number' ? Math.round(amount) / 100 : undefined
}

/**
 * The plan a workspace is actually entitled to RIGHT NOW.
 *
 * FIX (Billing fix round — LOW/MEDIUM): trial expiry was enforced only by the
 * daily payment-overdue cron flipping plan_tier to 'solo'. Until it ran (or
 * if it failed for a day), an expired trial kept unlimited projects, 10 seats
 * and custom roles. Anything that gates on a plan should use this instead of
 * the raw plan_tier column so a trial past trial_ends_at is Solo immediately;
 * the cron then makes the stored value match. A trial with no trial_ends_at
 * at all is left alone (never silently downgrade on missing data).
 */
export function effectivePlanTier(
  planTier: Plan | null | undefined,
  trialEndsAt: string | null | undefined,
  now: number = Date.now(),
): Plan {
  const tier = planTier || 'trial'
  if (tier !== 'trial' || !trialEndsAt) return tier
  const ends = Date.parse(trialEndsAt)
  return !isNaN(ends) && ends < now ? 'solo' : tier
}

/**
 * Read-only lapse (no free tier). A workspace that has no subscription and is not comped — an expired trial, a
 * non-payment downgrade, a subscription whose paid period ended — keeps its data, exports, billing and the client
 * portal, but its members lose every permission that writes. `workspaces.lapsed_at` (migration 150) is the explicit
 * marker (set by the payment-overdue cron, cleared by a new subscription or a staff plan change), because "Solo with
 * no subscription" alone cannot tell a lapsed workspace from one staff comped. A stored trial that is past
 * trial_ends_at is lapsed the moment it expires, not at the next cron run (same rule as effectivePlanTier).
 */
export const LAPSED_KEEP_PERMISSIONS: ReadonlySet<string> = new Set([
  'VIEW_OWN_PROJECTS', 'VIEW_ALL_PROJECTS', 'VIEW_FINANCIALS', 'VIEW_CLIENT_DATA', 'ACCESS_GUARDIAN_HISTORY',
  'VIEW_AUDIT_LOG', 'VIEW_PORTFOLIO', 'MANAGE_BILLING', 'MANAGE_WORKSPACE_SETTINGS',
])

export function isWorkspaceLapsed(
  planTier: Plan | null | undefined,
  trialEndsAt: string | null | undefined,
  lapsedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (lapsedAt) return true
  return (planTier || 'trial') === 'trial' && effectivePlanTier(planTier, trialEndsAt, now) !== 'trial'
}
