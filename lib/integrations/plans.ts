// lib/integrations/plans.ts
//
// Which plans can use which integration. ONE table, so changing the rule is a one-line edit.
//
//   • Webhooks / Zapier / API keys: Starter and up. Cheap to run, and the thing that makes a small agency stick.
//   • Slack, HubSpot, Google Drive: Pro and up. They carry OAuth, third-party review and support cost.
//   • A trial gets everything (that is what a trial is for) until it expires; an expired trial is Solo (effectivePlanTier).
//   • Solo gets none. A LAPSED workspace (no subscription) gets none either: nothing is delivered on its behalf.

import type { Plan } from '@/lib/supabase/types'
import { cheapestPlanWith, hasFeature, type PlanFeatures } from '@/lib/billing/entitlements'

export type IntegrationKind = 'webhook' | 'zapier' | 'api_keys' | 'slack' | 'hubspot' | 'google_drive'

// Which plan feature each integration rides on. The plan table itself (lib/billing/entitlements.ts) decides which plans have
// the feature, so the rule is edited in ONE place and the plan cards, the settings screen and these gates agree.
const FEATURE_OF: Record<IntegrationKind, Extract<keyof PlanFeatures, 'integrations' | 'nativeIntegrations'>> = {
  webhook:      'integrations',
  zapier:       'integrations',
  api_keys:     'integrations',
  slack:        'nativeIntegrations',
  hubspot:      'nativeIntegrations',
  google_drive: 'nativeIntegrations',
}

export const INTEGRATION_MIN_PLAN: Record<IntegrationKind, Plan> = Object.fromEntries(
  (Object.keys(FEATURE_OF) as IntegrationKind[]).map(k => [k, cheapestPlanWith(e => e.features[FEATURE_OF[k]]) ?? 'agency']),
) as Record<IntegrationKind, Plan>

/** `planTier` must already be the EFFECTIVE tier (session.planTier, or effectivePlanTier(...)). */
export function integrationAllowed(kind: IntegrationKind, planTier: Plan | null | undefined, lapsed = false): boolean {
  if (lapsed) return false
  return hasFeature(planTier, FEATURE_OF[kind])
}

/** The plan to name in an upgrade message. */
export function minPlanLabel(kind: IntegrationKind): string {
  const p = INTEGRATION_MIN_PLAN[kind]
  return p.charAt(0).toUpperCase() + p.slice(1)
}

// Customer webhooks. Zapier hooks (one per active Zap trigger) have their own, larger cap — see zapier.ts.
export const MAX_SUBSCRIPTIONS_PER_WORKSPACE = 10
export const MAX_API_KEYS_PER_WORKSPACE = 10
export const MAX_SLACK_RULES = 10
