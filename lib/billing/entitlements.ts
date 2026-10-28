// lib/billing/entitlements.ts
//
// ONE table for what each plan is, costs and includes. Before this file the same facts were copied into seven places
// (PLAN_LIMITS in lib/utils/format.ts, LIST_PRICES_USD, the homepage HOME_PLANS, the plan cards in SettingsClient,
// PLAN_FEATURES in the calculator model, CUSTOM_ROLE_PLANS in the roles route AND TeamClient, and the integrations rank
// table), held together only by tests. Everything below is now DERIVED from PLAN_ENTITLEMENTS, so changing a tier is a
// one-place edit and the pricing page, the in-app plan cards, the calculator, the limits and the gates cannot disagree.
//
// This module is a leaf: it imports types only, so lib/utils/format.ts, lib/billing/*, lib/integrations/* and client
// components can all import it without a cycle.
//
// Rules that are NOT in the table and live next to the code that applies them:
//   - A trial gets everything (that is what a trial is for) until it expires; an expired trial is Solo (effectivePlanTier).
//   - A LAPSED workspace (no subscription, not comped) is read-only. It keeps VIEWING and EXPORTING what it already has
//     (READ_ONLY_FEATURES below), and loses everything that creates or configures (approvals, roles, integrations, AI).

import type { Plan } from '@/lib/supabase/types'

export const PAID_PLAN_ORDER = ['solo', 'starter', 'pro', 'agency'] as const
export type PaidPlan = (typeof PAID_PLAN_ORDER)[number]

export interface PlanFeatures {
  /** Custom roles & permissions (Team -> Roles). */
  customRoles: boolean
  /** The SOW and invoice registries list every document (false = only the latest 10). */
  fullHistory: boolean
  /** Invoice ledger CSV export. */
  invoiceExport: boolean
  /** The workspace-wide Portfolio view (VIEW_PORTFOLIO). */
  portfolio: boolean
  /** Audit-log CSV export (the in-app audit log itself is open on every plan: it is a security record). */
  auditExport: boolean
  /** Approver steps allowed in one approval workflow. 0 = approval workflows are not available, null = unlimited. */
  approvalMaxSteps: number | null
  /** Webhooks, Zapier and API keys. */
  integrations: boolean
  /** Native Slack, HubSpot and Google Drive connections. Slack is built; HubSpot and Google Drive are not yet (the gate is ready for them). */
  nativeIntegrations: boolean
}

export interface PlanEntitlement {
  name: string
  seats: number
  /** Simultaneously active projects; null = unlimited. */
  projects: number | null
  /** USD list prices; null for the trial. */
  prices: { monthly: number; annual: number } | null
  features: PlanFeatures
  /**
   * AI drafts per calendar month (UTC), counted across the five drafting routes in AI_DRAFT_ROUTE_KEYS. Guardian
   * monitoring is deliberately NOT metered monthly: a refused check is a scope flag that never gets raised, which is the
   * one failure this product exists to prevent. Guardian keeps its per-window burst limits (lib/utils/rate-limit.ts).
   * These numbers are the knob: change them here and every limit, message and plan card follows.
   */
  aiDraftsPerMonth: number
}

export const PLAN_ENTITLEMENTS: Record<Plan, PlanEntitlement> = {
  trial: {
    name: 'Trial (14 days)', seats: 10, projects: null, prices: null,
    features: { customRoles: true, fullHistory: true, invoiceExport: true, portfolio: true, auditExport: true, approvalMaxSteps: null, integrations: true, nativeIntegrations: true },
    aiDraftsPerMonth: 600,
  },
  solo: {
    name: 'Solo', seats: 1, projects: 3, prices: { monthly: 39, annual: 390 },
    features: { customRoles: false, fullHistory: true, invoiceExport: true, portfolio: false, auditExport: false, approvalMaxSteps: 0, integrations: false, nativeIntegrations: false },
    aiDraftsPerMonth: 60,
  },
  starter: {
    name: 'Starter', seats: 3, projects: 8, prices: { monthly: 99, annual: 990 },
    features: { customRoles: false, fullHistory: true, invoiceExport: true, portfolio: false, auditExport: false, approvalMaxSteps: 1, integrations: true, nativeIntegrations: false },
    aiDraftsPerMonth: 200,
  },
  pro: {
    name: 'Pro', seats: 5, projects: null, prices: { monthly: 249, annual: 2490 },
    features: { customRoles: true, fullHistory: true, invoiceExport: true, portfolio: true, auditExport: false, approvalMaxSteps: null, integrations: true, nativeIntegrations: true },
    aiDraftsPerMonth: 600,
  },
  agency: {
    name: 'Agency', seats: 10, projects: null, prices: { monthly: 399, annual: 3990 },
    features: { customRoles: true, fullHistory: true, invoiceExport: true, portfolio: true, auditExport: true, approvalMaxSteps: null, integrations: true, nativeIntegrations: true },
    aiDraftsPerMonth: 1500,
  },
}

/** The routes whose model calls count against `aiDraftsPerMonth` (route keys written to ai_usage_log). */
export const AI_DRAFT_ROUTE_KEYS = ['sow.parseBrief', 'sow.generate', 'sow.regenerateSection', 'co.draft', 'invoice.draft'] as const

/** Unknown or missing plans resolve to Solo, the same fallback the integrations table and effectivePlanTier use. */
export function entitlementsFor(plan: Plan | string | null | undefined): PlanEntitlement {
  return (PLAN_ENTITLEMENTS as Record<string, PlanEntitlement>)[String(plan || 'solo')] ?? PLAN_ENTITLEMENTS.solo
}

/**
 * Features a lapsed (read-only) workspace keeps: they are VIEWING or EXPORTING what the workspace already holds, which the
 * Terms, the FAQ and the read-only banner all promise ("you can still view and export everything"). Without this a
 * lapsed Pro workspace fell back to Solo and lost its own ledger export.
 */
export const READ_ONLY_FEATURES: ReadonlySet<keyof PlanFeatures> = new Set<keyof PlanFeatures>([
  'fullHistory', 'invoiceExport', 'auditExport', 'portfolio',
])

/** Is a boolean feature available to this (effective) plan? A lapsed workspace keeps the read-only ones. */
export function hasFeature(
  plan: Plan | string | null | undefined,
  feature: Exclude<keyof PlanFeatures, 'approvalMaxSteps'>,
  lapsed = false,
): boolean {
  if (lapsed) return READ_ONLY_FEATURES.has(feature)
  return entitlementsFor(plan).features[feature]
}

/** Approver steps one approval workflow may have on this plan (0 = none, null = unlimited). Lapsed = none (it is a write). */
export function approvalMaxSteps(plan: Plan | string | null | undefined, lapsed = false): number | null {
  if (lapsed) return 0
  return entitlementsFor(plan).features.approvalMaxSteps
}

/** True when a workflow with `steps` approver steps may be created or activated on this plan. */
export function approvalStepsAllowed(plan: Plan | string | null | undefined, steps: number, lapsed = false): boolean {
  const max = approvalMaxSteps(plan, lapsed)
  return max === null || steps <= max
}

/**
 * Why a workflow with `steps` approver steps may not be created or activated on this plan, or null when it may. Used by the
 * approval-workflow routes (the server is the gate) and the settings screen (the same words, before the request is made).
 */
export function approvalPlanGate(plan: Plan | string | null | undefined, steps: number, lapsed = false): string | null {
  if (approvalStepsAllowed(plan, steps, lapsed)) return null
  if (lapsed) return 'This workspace has no active plan, so approval workflows are read-only. Subscribe in Settings \u2192 Billing to change them.'
  const max = approvalMaxSteps(plan, lapsed) ?? 0
  if (max === 0) {
    const p = cheapestPlanWith(e => e.features.approvalMaxSteps !== 0)
    return `Approval workflows are available on the ${p ? PLAN_ENTITLEMENTS[p].name : 'Starter'} plan and above.`
  }
  const p = cheapestPlanWith(e => e.features.approvalMaxSteps === null || e.features.approvalMaxSteps >= steps)
  return `Your ${planDisplayName(plan)} plan allows ${max} approver step${max === 1 ? '' : 's'} per workflow. A ${steps}-step chain needs the ${p ? PLAN_ENTITLEMENTS[p].name : 'Pro'} plan or above.`
}

/** The cheapest paid plan that has the feature, for upgrade messages. */
export function cheapestPlanWith(test: (e: PlanEntitlement) => boolean): PaidPlan | null {
  return PAID_PLAN_ORDER.find(p => test(PLAN_ENTITLEMENTS[p])) ?? null
}

/** Name of the cheapest paid plan that has a boolean feature ("Pro"), for upgrade messages. */
export function minPlanNameFor(feature: Exclude<keyof PlanFeatures, 'approvalMaxSteps'>): string {
  const p = cheapestPlanWith(e => e.features[feature])
  return p ? PLAN_ENTITLEMENTS[p].name : 'a higher'
}

export function planDisplayName(plan: Plan | string | null | undefined): string {
  return entitlementsFor(plan).name.replace(/\s*\(.*\)\s*$/, '')
}

// ── Display ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Wording for the pricing page and the in-app plan cards, generated from the table so the two cannot drift.

export function describeApprovals(plan: PaidPlan): string {
  const max = PLAN_ENTITLEMENTS[plan].features.approvalMaxSteps
  if (max === 0) return 'Not included'
  if (max === 1) return 'Single approver'
  return 'Multi-step chains'
}

export function describeIntegrations(plan: PaidPlan): string {
  const f = PLAN_ENTITLEMENTS[plan].features
  if (!f.integrations) return 'Not included'
  return f.nativeIntegrations ? 'Webhooks, Zapier, API keys, Slack' : 'Webhooks, Zapier, API keys'
}

export function describeAiDrafts(plan: PaidPlan): string {
  return `${PLAN_ENTITLEMENTS[plan].aiDraftsPerMonth.toLocaleString('en-US')} a month`
}

export interface PlanFeatureRow { label: string; value: string; included: boolean }

/** The rows both plan cards show, in one order. `included` is false for a plain "not included". */
export function planFeatureRows(plan: PaidPlan): PlanFeatureRow[] {
  const e = PLAN_ENTITLEMENTS[plan]
  const f = e.features
  return [
    { label: 'Seats', value: String(e.seats), included: true },
    { label: 'Active projects', value: e.projects === null ? 'Unlimited' : String(e.projects), included: true },
    { label: 'Guardian monitoring', value: 'Included', included: true },
    { label: 'AI drafts', value: describeAiDrafts(plan), included: true },
    { label: 'Approvals', value: describeApprovals(plan), included: f.approvalMaxSteps !== 0 },
    { label: 'Integrations', value: describeIntegrations(plan), included: f.integrations },
    { label: 'Custom roles', value: f.customRoles ? 'Included' : 'Not included', included: f.customRoles },
    { label: 'Portfolio view', value: f.portfolio ? 'Included' : 'Not included', included: f.portfolio },
    { label: 'Audit-log export', value: f.auditExport ? 'Included' : 'Not included', included: f.auditExport },
  ]
}

// ── Calculator needs ────────────────────────────────────────────────────────────────────────────────────────────────
// The "I need..." checkboxes on the homepage calculator and the full calculator. One list, so both render the same ones and
// the plan the calculator recommends is the plan that actually has them.

export type NeedKey = 'customRoles' | 'approvalChains' | 'integrations' | 'portfolio' | 'auditExport'

export const FEATURE_NEEDS: ReadonlyArray<{ key: NeedKey; label: string; urlKey: string }> = [
  { key: 'customRoles',    label: 'Custom roles & permissions',  urlKey: 'roles' },
  { key: 'approvalChains', label: 'Multi-step approval chains',  urlKey: 'chains' },
  { key: 'integrations',   label: 'Webhooks, Zapier & API keys', urlKey: 'integrations' },
  { key: 'portfolio',      label: 'Portfolio view',              urlKey: 'portfolio' },
  { key: 'auditExport',    label: 'Audit-log export',            urlKey: 'auditexport' },
]

export function planMeetsNeed(plan: PaidPlan, need: NeedKey): boolean {
  const f = PLAN_ENTITLEMENTS[plan].features
  switch (need) {
    case 'customRoles':    return f.customRoles
    case 'approvalChains': return f.approvalMaxSteps === null || f.approvalMaxSteps > 1
    case 'integrations':   return f.integrations
    case 'portfolio':      return f.portfolio
    case 'auditExport':    return f.auditExport
  }
}

/** Plain-words reason a plan does not cover a need ("no custom roles"). */
export function needGapReason(need: NeedKey): string {
  switch (need) {
    case 'customRoles':    return 'no custom roles'
    case 'approvalChains': return 'no multi-step approval chains'
    case 'integrations':   return 'no webhooks, Zapier or API keys'
    case 'portfolio':      return 'no portfolio view'
    case 'auditExport':    return 'no audit-log export'
  }
}
