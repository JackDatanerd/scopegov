// Tiers & pricing round: one plan table (lib/billing/entitlements.ts), the lapsed-workspace fix, the approval / portfolio /
// audit-export gates, and the monthly AI drafting allowance.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createFakeSupabase } from './helpers/fake-supabase'
import {
  PLAN_ENTITLEMENTS, PAID_PLAN_ORDER, AI_DRAFT_ROUTE_KEYS, hasFeature, approvalPlanGate, approvalStepsAllowed, approvalMaxSteps,
  entitlementsFor, planFeatureRows, minPlanNameFor, FEATURE_NEEDS, planMeetsNeed,
} from '@/lib/billing/entitlements'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { LIST_PRICES_USD } from '@/lib/billing/list-prices'
import { PAID_PLAN_KEYS } from '@/lib/billing/plans'
import { INTEGRATION_MIN_PLAN, integrationAllowed } from '@/lib/integrations/plans'
import { claimAiRateSlot, getAiDraftUsage, aiDraftMonthWindow, isAiDraftRoute } from '@/lib/utils/rate-limit'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('the plan table is the one source', () => {
  it('PLAN_LIMITS, LIST_PRICES_USD and PAID_PLAN_KEYS are derived from it', () => {
    for (const k of PAID_PLAN_ORDER) {
      expect(PLAN_LIMITS[k]).toEqual({ projects: PLAN_ENTITLEMENTS[k].projects, seats: PLAN_ENTITLEMENTS[k].seats, name: PLAN_ENTITLEMENTS[k].name })
      expect(LIST_PRICES_USD[k]).toEqual(PLAN_ENTITLEMENTS[k].prices)
    }
    expect(PLAN_LIMITS.trial).toEqual({ projects: null, seats: 10, name: 'Trial (14 days)' })
    expect([...PAID_PLAN_KEYS]).toEqual([...PAID_PLAN_ORDER])
  })

  it('each tier is a strict step up: more seats, equal or more projects, equal or more of every feature, a bigger AI allowance', () => {
    for (let i = 1; i < PAID_PLAN_ORDER.length; i++) {
      const lo = PLAN_ENTITLEMENTS[PAID_PLAN_ORDER[i - 1]], hi = PLAN_ENTITLEMENTS[PAID_PLAN_ORDER[i]]
      expect(hi.seats).toBeGreaterThan(lo.seats)
      expect(hi.aiDraftsPerMonth).toBeGreaterThan(lo.aiDraftsPerMonth)
      expect(hi.prices!.monthly).toBeGreaterThan(lo.prices!.monthly)
      expect(hi.projects === null || (lo.projects !== null && hi.projects >= lo.projects)).toBe(true)
      for (const [f, v] of Object.entries(lo.features)) {
        if (f === 'approvalMaxSteps') {
          expect(hi.features.approvalMaxSteps === null || (lo.features.approvalMaxSteps !== null && hi.features.approvalMaxSteps >= lo.features.approvalMaxSteps)).toBe(true)
        } else if (v) expect(hi.features[f as keyof typeof hi.features], `${PAID_PLAN_ORDER[i]} keeps ${f}`).toBe(true)
      }
    }
  })

  it('"2 months free" is true for every plan, and a trial gets everything', () => {
    for (const k of PAID_PLAN_ORDER) expect(PLAN_ENTITLEMENTS[k].prices!.annual).toBe(PLAN_ENTITLEMENTS[k].prices!.monthly * 10)
    const t = PLAN_ENTITLEMENTS.trial.features
    expect(t.customRoles && t.portfolio && t.auditExport && t.integrations && t.nativeIntegrations && t.approvalMaxSteps === null).toBe(true)
  })

  it('the tiers are what the pricing round decided', () => {
    expect(PAID_PLAN_ORDER.map(k => [PLAN_ENTITLEMENTS[k].seats, PLAN_ENTITLEMENTS[k].projects])).toEqual([[1, 3], [3, 8], [5, null], [10, null]])
    expect(PAID_PLAN_ORDER.map(k => PLAN_ENTITLEMENTS[k].prices!.monthly)).toEqual([39, 99, 249, 399])
    expect(PAID_PLAN_ORDER.map(k => PLAN_ENTITLEMENTS[k].features.approvalMaxSteps)).toEqual([0, 1, null, null])
    expect(PAID_PLAN_ORDER.map(k => PLAN_ENTITLEMENTS[k].features.portfolio)).toEqual([false, false, true, true])
    expect(PAID_PLAN_ORDER.map(k => PLAN_ENTITLEMENTS[k].features.auditExport)).toEqual([false, false, false, true])
  })

  it('integrations ride the table: webhooks/Zapier/API from Starter, native apps from Pro, none while lapsed', () => {
    expect(INTEGRATION_MIN_PLAN).toEqual({ webhook: 'starter', zapier: 'starter', api_keys: 'starter', slack: 'pro', hubspot: 'pro', google_drive: 'pro' })
    expect(integrationAllowed('webhook', 'solo')).toBe(false)
    expect(integrationAllowed('webhook', 'starter')).toBe(true)
    expect(integrationAllowed('slack', 'starter')).toBe(false)
    expect(integrationAllowed('slack', 'trial')).toBe(true)
    expect(integrationAllowed('webhook', 'agency', true)).toBe(false)
  })

  it('the plan cards list every feature row, from the same function on both surfaces', () => {
    const labels = planFeatureRows('solo').map(r => r.label)
    expect(labels).toEqual(['Seats', 'Active projects', 'Guardian monitoring', 'AI drafts', 'Approvals', 'Integrations', 'Custom roles', 'Portfolio view', 'Audit-log export'])
    expect(planFeatureRows('starter').find(r => r.label === 'Approvals')!.value).toBe('Single approver')
    expect(planFeatureRows('pro').find(r => r.label === 'Approvals')!.value).toBe('Multi-step chains')
    expect(planFeatureRows('solo').find(r => r.label === 'Integrations')!.included).toBe(false)
    // the card only names what exists: Slack is built, HubSpot and Google Drive are not
    expect(planFeatureRows('pro').find(r => r.label === 'Integrations')!.value).toBe('Webhooks, Zapier, API keys, Slack')
    expect(planFeatureRows('pro').find(r => r.label === 'Integrations')!.value).not.toMatch(/HubSpot|Drive/)
    expect(read('components/settings/SettingsClient.tsx')).toContain('planFeatureRows(key)')
    expect(read('components/marketing/pricing-data.ts')).toContain('planFeatureRows(key)')
  })

  it('every calculator need maps to a plan that really has it', () => {
    for (const n of FEATURE_NEEDS) expect(PAID_PLAN_ORDER.some(p => planMeetsNeed(p, n.key)), n.key).toBe(true)
    expect(minPlanNameFor('portfolio')).toBe('Pro')
    expect(minPlanNameFor('auditExport')).toBe('Agency')
    expect(entitlementsFor(undefined).name).toBe('Solo')
    expect(entitlementsFor('nonsense').name).toBe('Solo')
  })
})

describe('a lapsed (read-only) workspace keeps viewing and exporting what it holds', () => {
  it('keeps history, invoice export, audit export and portfolio even though it is stored as Solo', () => {
    for (const f of ['fullHistory', 'invoiceExport', 'auditExport', 'portfolio'] as const) {
      expect(hasFeature('solo', f, true), f).toBe(true)
    }
  })
  it('loses everything that creates or configures', () => {
    for (const f of ['customRoles', 'integrations', 'nativeIntegrations'] as const) expect(hasFeature('agency', f, true), f).toBe(false)
    expect(approvalMaxSteps('agency', true)).toBe(0)
  })
  it('a non-lapsed Solo workspace is gated as the table says', () => {
    expect(hasFeature('solo', 'portfolio')).toBe(false)
    expect(hasFeature('solo', 'auditExport')).toBe(false)
    expect(hasFeature('solo', 'invoiceExport')).toBe(true)
    expect(hasFeature('agency', 'auditExport')).toBe(true)
  })
  it('the registry pages and the invoice export decide through hasFeature with the lapsed flag (the bug was planTier === \'solo\')', () => {
    for (const f of ['app/(app)/invoices/page.tsx', 'app/(app)/sow/page.tsx']) {
      const src = read(f)
      expect(src).toMatch(/hasFeature\(session\.planTier, 'fullHistory', !!session\.lapsed\)/)
      expect(src).not.toMatch(/planTier === 'solo'/)
    }
    const exp = read('app/api/invoices/export/route.ts')
    expect(exp).toMatch(/hasFeature\(session\.planTier, 'invoiceExport', !!session\.lapsed\)/)
    expect(exp).not.toMatch(/planTier === 'solo'/)
  })
})

describe('approval workflows are gated by plan', () => {
  it('Solo: none. Starter: one approver step. Pro and up: chains. Trial: everything', () => {
    expect(approvalStepsAllowed('solo', 1)).toBe(false)
    expect(approvalStepsAllowed('starter', 1)).toBe(true)
    expect(approvalStepsAllowed('starter', 2)).toBe(false)
    expect(approvalStepsAllowed('pro', 7)).toBe(true)
    expect(approvalStepsAllowed('agency', 7)).toBe(true)
    expect(approvalStepsAllowed('trial', 9)).toBe(true)
  })
  it('the refusal names the plan that has it', () => {
    expect(approvalPlanGate('solo', 1)).toMatch(/available on the Starter plan and above/)
    expect(approvalPlanGate('starter', 2)).toMatch(/allows 1 approver step per workflow.*needs the Pro plan/)
    expect(approvalPlanGate('pro', 5)).toBeNull()
  })
  it('a lapsed workspace is told it is read-only, not to upgrade a plan it does not have', () => {
    expect(approvalPlanGate('agency', 1, true)).toMatch(/no active plan/)
  })
  it('create and activate/replace-steps are gated; switching off and renaming are not', () => {
    const post = read('app/api/approval-workflows/route.ts')
    expect(post).toMatch(/approvalPlanGate\(session\.planTier, steps\.length, !!session\.lapsed\)/)
    expect(post.indexOf('approvalPlanGate(')).toBeLessThan(post.indexOf(".insert({"))
    const patch = read('app/api/approval-workflows/[id]/route.ts')
    expect(patch).toMatch(/if \(steps \|\| \(resultingActive && !existing\.is_active\)\)/)
    const gateAt = patch.indexOf('approvalPlanGate(')
    expect(gateAt).toBeGreaterThan(patch.indexOf('const resultingActive'))
    // the DELETE handler (which only deactivates) is not gated
    expect(patch.slice(patch.indexOf('export async function DELETE'))).not.toMatch(/approvalPlanGate/)
  })
})

describe('portfolio and audit export gates', () => {
  it('the portfolio page, both APIs, the sidebar link and the command palette all check the plan', () => {
    expect(read('app/(app)/portfolio/page.tsx')).toMatch(/hasFeature\(session\.planTier, 'portfolio', !!session\.lapsed\)/)
    expect(read('app/api/reports/portfolio/route.ts')).toMatch(/hasFeature\(session\.planTier, 'portfolio', !!session\.lapsed\)/)
    expect(read('app/api/reports/portfolio/export/route.ts')).toMatch(/hasFeature\(session\.planTier, 'portfolio', !!session\.lapsed\)/)
    expect(read('components/layout/Sidebar.tsx')).toMatch(/feature: 'portfolio'/)
    expect(read('components/layout/Sidebar.tsx')).toMatch(/hasFeature\(session\.planTier/)
    expect(read('app/(app)/layout.tsx')).toMatch(/portfolio=\{hasFeature\(session\.planTier, 'portfolio'/)
  })
  it('the session keeps VIEW_PORTFOLIO (stripping it would block role editing on lower plans)', () => {
    expect(read('lib/auth/session.ts')).not.toMatch(/portfolio/i)
  })
  it('audit export gates only the CSV and PDF downloads, never the in-app JSON view', () => {
    const src = read('app/api/reports/audit-export/route.ts')
    expect(src).toMatch(/if \(format !== 'json' && !hasFeature\(session\.planTier, 'auditExport', !!session\.lapsed\)\)/)
    expect(src.indexOf("format !== 'json' && !hasFeature")).toBeGreaterThan(src.indexOf("const format = formatRaw"))
    expect(read('app/(app)/settings/audit/page.tsx')).toMatch(/canExport=\{hasFeature\(session\.planTier, 'auditExport'/)
  })
})

// ── Monthly AI drafting allowance ───────────────────────────────────────────────────────────────────────────────────────
const WS = 'ws-1'
const DAYS = 86_400_000

function seedUsage(n: number, routeKey: string, opts: { daysAgo?: number; users?: number } = {}) {
  // Spread over distinct users and older than the 10-minute burst window, so only the MONTHLY allowance can refuse.
  const created = new Date(Date.now() - (opts.daysAgo ?? 0) * DAYS - 3_600_000).toISOString()
  return Array.from({ length: n }, (_, i) => ({ id: `u${routeKey}${i}${opts.daysAgo ?? 0}`, workspace_id: WS, user_id: `user-${i % (opts.users ?? 50)}`, route_key: routeKey, created_at: created }))
}
const db = (plan: string, rows: any[], trialEndsAt: string | null = null) =>
  createFakeSupabase({ workspaces: [{ id: WS, plan_tier: plan, trial_ends_at: trialEndsAt }], ai_usage_log: rows })
// claimAiRateSlot / getAiDraftUsage take the supabase CLIENT; the fake also exposes its tables for assertions.
const claim = (fake: ReturnType<typeof db>, route: string) => claimAiRateSlot(fake.client, WS, 'me', route)

describe('monthly AI drafting allowance', () => {
  const window = aiDraftMonthWindow()
  // Rows are stamped "one hour ago", which can fall in the previous month in the first hour of a month; those tests would
  // then be counting last month's rows. Skip the month-boundary hour rather than flake.
  const sameMonth = new Date(Date.now() - 3_600_000) >= window.start

  it.runIf(sameMonth)('allows a draft while under the plan allowance and refuses the one past it, with the reset date', async () => {
    const limit = PLAN_ENTITLEMENTS.solo.aiDraftsPerMonth
    const under = db('solo', seedUsage(limit - 1, 'sow.generate'))
    expect((await claim(under, 'sow.generate')).allowed).toBe(true)

    const full = db('solo', seedUsage(limit, 'co.draft'))
    const r = await claim(full, 'co.draft')
    expect(r.allowed).toBe(false)
    expect(r.message).toContain(`${limit} AI drafts included in the Solo plan`)
    expect(r.message).toMatch(/resets on [A-Z][a-z]+ \d+ \(UTC\)/)
    expect(r.message).toContain('Upgrade')
    // the refused request's row is withdrawn, so a refusal does not use the allowance
    expect(full.tables.ai_usage_log.length).toBe(limit)
  })

  it.runIf(sameMonth)('counts all five drafting routes together', async () => {
    const limit = PLAN_ENTITLEMENTS.solo.aiDraftsPerMonth
    const per = Math.floor(limit / 5)
    const rows = AI_DRAFT_ROUTE_KEYS.flatMap(k => seedUsage(per, k))
    const rest = limit - per * 5
    const d = db('solo', [...rows, ...seedUsage(rest, 'sow.generate', { users: 3 })])
    expect((await claim(d, 'invoice.draft')).allowed).toBe(false)
  })

  it.runIf(sameMonth)('a higher plan has a higher allowance, and an expired trial is metered as Solo', async () => {
    const solo = PLAN_ENTITLEMENTS.solo.aiDraftsPerMonth
    expect((await claim(db('pro', seedUsage(solo, 'sow.generate')), 'sow.generate')).allowed).toBe(true)
    const expired = new Date(Date.now() - DAYS).toISOString()
    expect((await claim(db('trial', seedUsage(solo, 'sow.generate'), expired), 'sow.generate')).allowed).toBe(false)
    const live = new Date(Date.now() + DAYS).toISOString()
    expect((await claim(db('trial', seedUsage(solo, 'sow.generate'), live), 'sow.generate')).allowed).toBe(true)
  })

  it('last month\'s usage does not count', async () => {
    const solo = PLAN_ENTITLEMENTS.solo.aiDraftsPerMonth
    const d = db('solo', seedUsage(solo * 2, 'sow.generate', { daysAgo: 45 }))
    expect((await claim(d, 'sow.generate')).allowed).toBe(true)
  })

  it('Guardian is NOT metered monthly: a refused check is a scope flag that never gets raised', async () => {
    expect(isAiDraftRoute('guardian.check')).toBe(false)
    expect(isAiDraftRoute('guardian.inbound')).toBe(false)
    expect(isAiDraftRoute('co.draft')).toBe(true)
    const d = db('solo', seedUsage(5000, 'guardian.check', { users: 500 }))
    expect((await claim(d, 'guardian.check')).allowed).toBe(true)
  })

  it('fails open when the workspace or usage cannot be read', async () => {
    const d = createFakeSupabase({ workspaces: [{ id: WS, plan_tier: 'solo' }], ai_usage_log: [] }, { errors: [{ table: 'workspaces', op: 'select' }] })
    expect((await claim(d, 'sow.generate')).allowed).toBe(true)
    // The allowance check itself throwing (not just returning an error) must also fail open: only the workspaces read is broken.
    const ok = db('solo', [])
    const throwing = { from: (t: string) => { if (t === 'workspaces') throw new Error('socket hang up'); return (ok.client as any).from(t) } }
    expect((await claimAiRateSlot(throwing, WS, 'me', 'sow.generate')).allowed).toBe(true)
  })

  it('getAiDraftUsage reports used, limit and the first of next month (UTC)', async () => {
    const d = db('starter', seedUsage(7, 'sow.generate'))
    const u = await getAiDraftUsage(d.client, WS, 'starter', new Date())
    expect(sameMonth ? u!.used : 7).toBe(7)
    expect(u!.limit).toBe(PLAN_ENTITLEMENTS.starter.aiDraftsPerMonth)
    expect(u!.resetsAt).toBe(aiDraftMonthWindow().resetsAt.toISOString())
    expect(new Date(u!.resetsAt).getUTCDate()).toBe(1)
  })

  it('month window handles December -> January', () => {
    const w = aiDraftMonthWindow(new Date('2026-12-15T10:00:00Z'))
    expect(w.start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(w.resetsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('every drafting route goes through claimAiRateSlot and returns its message, and retention outlives a month', () => {
    for (const f of ['sow/parse-brief', 'sow/generate', 'sow/regenerate-section', 'co/draft', 'invoices/draft']) {
      const src = read(`app/api/${f}/route.ts`)
      expect(src, f).toMatch(/claimAiRateSlot\(service, session\.workspaceId, session\.id, '/)
      expect(src, f).toMatch(/if \(!limited\.allowed\) return NextResponse\.json\(\{ error: limited\.message \}, \{ status: 429 \}\)/)
    }
    const m = read('app/api/cron/notification-cleanup/route.ts').match(/const AI_USAGE_DAYS\s*=\s*(\d+)/)
    expect(Number(m![1])).toBeGreaterThanOrEqual(62)
    expect(read('supabase/migrations/168_ai_usage_monthly_allowance.sql')).toMatch(/\(workspace_id, route_key, created_at DESC\)/)
  })

  it('the Billing tab shows usage against the allowance', () => {
    expect(read('app/(app)/settings/page.tsx')).toContain('getAiDraftUsage(service, session.workspaceId, session.planTier)')
    expect(read('components/settings/SettingsClient.tsx')).toMatch(/AI drafts this month/)
  })
})

describe('copy that used to quote old limits', () => {
  it('the Team upsell is generated from the table, and the pricing footnote no longer says "unlimited AI-drafted SOWs"', () => {
    expect(read('app/(app)/team/page.tsx')).toContain('PLAN_ENTITLEMENTS[k]')
    expect(read('app/(app)/team/page.tsx')).not.toContain("'$99/mo'")
    const pricing = read('components/marketing/PricingSection.tsx')
    expect(pricing).not.toMatch(/unlimited Guardian monitoring and AI-drafted SOWs/)
    expect(pricing).toMatch(/AI drafting \(with a monthly allowance\)/)
  })
})
