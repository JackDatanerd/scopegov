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

export const PAID_PLAN_KEYS = ['solo', 'starter', 'pro', 'agency'] as const
export type PaidPlanKey = (typeof PAID_PLAN_KEYS)[number]
export const BILLING_INTERVALS = ['monthly', 'annual'] as const
export type BillingInterval = (typeof BILLING_INTERVALS)[number]

// One source of truth for the grace window (it used to be a literal 5 in the
// webhook, the UI banner and the cron, which could drift independently).
export const GRACE_DAYS = 5
export const GRACE_REMINDER_DAYS_LEFT = 3

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
