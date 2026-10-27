// lib/integrations/plans.ts
//
// Which plans can use which integration. ONE table, so changing the rule is a one-line edit.
//
//   • Webhooks / Zapier / API keys: Starter and up. Cheap to run, and the thing that makes a small agency stick.
//   • Slack, HubSpot, Google Drive: Pro and up. They carry OAuth, third-party review and support cost.
//   • A trial gets everything (that is what a trial is for) until it expires; an expired trial is Solo (effectivePlanTier).
//   • Solo gets none. A LAPSED workspace (no subscription) gets none either: nothing is delivered on its behalf.

import type { Plan } from '@/lib/supabase/types'

export type IntegrationKind = 'webhook' | 'zapier' | 'api_keys' | 'slack' | 'hubspot' | 'google_drive'

const RANK: Record<Plan, number> = { solo: 0, starter: 1, trial: 3, pro: 2, agency: 3 }

export const INTEGRATION_MIN_PLAN: Record<IntegrationKind, Plan> = {
  webhook:      'starter',
  zapier:       'starter',
  api_keys:     'starter',
  slack:        'pro',
  hubspot:      'pro',
  google_drive: 'pro',
}

/** `planTier` must already be the EFFECTIVE tier (session.planTier, or effectivePlanTier(...)). */
export function integrationAllowed(kind: IntegrationKind, planTier: Plan | null | undefined, lapsed = false): boolean {
  if (lapsed) return false
  return RANK[planTier || 'solo'] >= RANK[INTEGRATION_MIN_PLAN[kind]]
}

/** The plan to name in an upgrade message. */
export function minPlanLabel(kind: IntegrationKind): string {
  const p = INTEGRATION_MIN_PLAN[kind]
  return p.charAt(0).toUpperCase() + p.slice(1)
}

// Customer webhooks. Zapier hooks (one per active Zap trigger) have their own, larger cap — see zapier.ts.
export const MAX_SUBSCRIPTIONS_PER_WORKSPACE = 10
export const MAX_API_KEYS_PER_WORKSPACE = 10
