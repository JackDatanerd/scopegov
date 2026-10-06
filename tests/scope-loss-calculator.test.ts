// tests/scope-loss-calculator.test.ts
//
// The scope-loss calculator: the pure model (credibility rules), the workspace-numbers loader (permission gate,
// windows, currency), and the wiring (public route, entry points, plan-table drift guards).

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  computeRoi, normalizeInputs, ownRecoveryRate, PLAN_FEATURES, BLANK_INPUTS,
  DEFAULT_RECOVERY_RATE, MIN_FLAGS_FOR_OWN_RATE, extrapolateToYear, extrapolationFields, MIN_DAYS_TO_EXTRAPOLATE, ROUGH_EXTRAPOLATION_DAYS, type RoiInputs,
} from '@/lib/billing/roi-model'
import { LIST_PRICES_USD } from '@/lib/billing/list-prices'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { loadRoiInputs } from '@/lib/billing/roi-inputs'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const base = (over: Partial<RoiInputs> = {}): Partial<RoiInputs> => ({
  projectsPerYear: 10, avgProjectValue: 10_000, creepPct: 10, grantedFreeValue: 0, recoveryRate: 0.25,
  seatsNeeded: 1, activeProjectsNeeded: 2, interval: 'monthly', currency: 'USD', ...over,
})

describe('model — the number', () => {
  it('starts at a 68% recovery rate — a placeholder the user adjusts, still clamped to 0–100%', () => {
    expect(DEFAULT_RECOVERY_RATE).toBe(0.68)
    expect(BLANK_INPUTS.recoveryRate).toBe(0.68)
    expect(normalizeInputs({}).recoveryRate).toBe(0.68)
    expect(normalizeInputs({ recoveryRate: 0.1 }).recoveryRate).toBe(0.1)   // adjustable
    expect(normalizeInputs({ recoveryRate: 2 }).recoveryRate).toBe(1)
  })

  it('billing defaults to ANNUAL; monthly only when asked for', () => {
    expect(BLANK_INPUTS.interval).toBe('annual')
    expect(normalizeInputs({}).interval).toBe('annual')
    expect(normalizeInputs({ interval: 'monthly' }).interval).toBe('monthly')
    expect(normalizeInputs({ interval: 'whatever' as any }).interval).toBe('annual')
    const solo = computeRoi({ ...base(), interval: undefined }).plans[0]
    expect(solo.annualCostUsd).toBe(390)       // the annual price, not 12 x monthly
  })

  it('estimate path: projects × value × creep%, then × recovery rate', () => {
    const r = computeRoi(base())
    expect(r.estimatedCreep).toBe(10_000)          // 10 × 10,000 × 10%
    expect(r.leaked).toBe(10_000)
    expect(r.leakedFrom).toBe('estimate')
    expect(r.recoverable).toBe(2_500)              // × 25%
  })

  it('uses the LARGER of estimate and measured granted-free — never both added', () => {
    const measuredBigger = computeRoi(base({ grantedFreeValue: 30_000 }))
    expect(measuredBigger.leaked).toBe(30_000)
    expect(measuredBigger.leakedFrom).toBe('measured')
    const estimateBigger = computeRoi(base({ grantedFreeValue: 4_000 }))
    expect(estimateBigger.leaked).toBe(10_000)
    expect(estimateBigger.leakedFrom).toBe('estimate')
    expect(measuredBigger.leaked).not.toBe(30_000 + 10_000)
  })

  it('net and payback use the plan price at the chosen interval', () => {
    const monthly = computeRoi(base()).plans.find(p => p.plan === 'solo')!
    expect(monthly.annualCostUsd).toBe(39 * 12)
    expect(monthly.net).toBe(2_500 - 468)
    expect(monthly.paybackMonths).toBeCloseTo((468 / 2_500) * 12, 6)
    const annual = computeRoi(base({ interval: 'annual' })).plans.find(p => p.plan === 'solo')!
    expect(annual.annualCostUsd).toBe(390)
    expect(annual.net).toBe(2_500 - 390)
  })

  it('zero leakage → no payback figure and an honest "not yet" verdict, never a recommendation to buy', () => {
    const r = computeRoi(base({ creepPct: 0, grantedFreeValue: 0 }))
    expect(r.recoverable).toBe(0)
    expect(r.recommended!.paybackMonths).toBeNull()
    expect(r.verdict).toBe('not_yet')
  })

  it('verdict flips on the sign of the net', () => {
    expect(computeRoi(base()).verdict).toBe('worth_it')                         // 2,500 recovered vs 468
    expect(computeRoi(base({ avgProjectValue: 1_000 })).verdict).toBe('not_yet') // 250 recovered vs 468
  })
})

describe('model — plan fit comes before price', () => {
  const rec = (over: Partial<RoiInputs>) => computeRoi(base(over)).recommended?.plan ?? null

  it('recommends the cheapest plan that fits', () => {
    expect(rec({})).toBe('solo')
    expect(rec({ seatsNeeded: 2 })).toBe('starter')
    expect(rec({ activeProjectsNeeded: 3 })).toBe('starter')
    expect(rec({ activeProjectsNeeded: 6 })).toBe('pro')     // Starter caps at 5
    expect(rec({ seatsNeeded: 5 })).toBe('agency')           // Pro caps at 4 seats
  })

  it('features gate the fit', () => {
    expect(rec({ needsFullHistory: true })).toBe('starter')  // Solo shows only the last 10 and blocks export
    expect(rec({ needsCustomRoles: true })).toBe('pro')
  })

  it('a team beyond every plan gets "no plan fits", not a wrong recommendation', () => {
    const r = computeRoi(base({ seatsNeeded: 11 }))
    expect(r.recommended).toBeNull()
    expect(r.verdict).toBe('no_plan_fits')
  })

  it('explains each plan that does not fit', () => {
    const solo = computeRoi(base({ seatsNeeded: 3, needsCustomRoles: true })).plans[0]
    expect(solo.fits).toBe(false)
    expect(solo.reasons.join(' ')).toMatch(/1 seat/)
    expect(solo.reasons.join(' ')).toMatch(/custom roles/)
  })

  it('"profitable but does not fit" can never win: a cheaper plan that cannot hold the team is skipped', () => {
    const r = computeRoi(base({ seatsNeeded: 4, creepPct: 50 }))
    expect(r.recommended!.plan).toBe('pro')
    expect(r.plans.find(p => p.plan === 'solo')!.net).not.toBeNull() // still computed, just not recommended
  })
})

describe('model — currency', () => {
  it('a non-USD workspace without an exchange rate gets no net figure at all', () => {
    const r = computeRoi(base({ currency: 'KES', avgProjectValue: 500_000 }))
    expect(r.verdict).toBe('needs_fx')
    for (const p of r.plans) { expect(p.net).toBeNull(); expect(p.annualCost).toBeNull(); expect(p.paybackMonths).toBeNull() }
  })

  it('with a rate, USD prices are converted into the user\'s currency before subtracting', () => {
    const r = computeRoi(base({ currency: 'KES', avgProjectValue: 500_000, fxToUsd: 0.0077 }))
    const solo = r.plans[0]
    expect(solo.annualCost).toBeCloseTo(468 / 0.0077, 4)
    expect(solo.net).toBeCloseTo(r.recoverable - 468 / 0.0077, 4)
  })

  it('a zero, negative or NaN rate is treated as no rate', () => {
    for (const fx of [0, -1, NaN, Infinity]) expect(computeRoi(base({ currency: 'EUR', fxToUsd: fx as any })).verdict).toBe('needs_fx')
  })

  it('USD ignores any rate', () => {
    expect(normalizeInputs({ currency: 'USD', fxToUsd: 5 }).fxToUsd).toBeNull()
  })
})

describe('model — hostile / sloppy input never yields NaN, Infinity or a negative', () => {
  it('clamps and falls back', () => {
    const n = normalizeInputs({
      projectsPerYear: -5, avgProjectValue: Infinity, creepPct: 900, grantedFreeValue: -1,
      recoveryRate: 7, seatsNeeded: 0, activeProjectsNeeded: NaN as any, currency: 'dollars',
    })
    expect(n.projectsPerYear).toBe(0)
    expect(Number.isFinite(n.avgProjectValue)).toBe(true)
    expect(n.creepPct).toBe(100)
    expect(n.grantedFreeValue).toBe(0)
    expect(n.recoveryRate).toBe(1)
    expect(n.seatsNeeded).toBe(1)
    expect(n.currency).toBe('USD')
  })

  it('every output is finite for garbage input', () => {
    const r = computeRoi({ projectsPerYear: 'abc' as any, avgProjectValue: {} as any, creepPct: null as any, recoveryRate: undefined })
    for (const v of [r.estimatedCreep, r.grantedFree, r.leaked, r.recoverable]) expect(Number.isFinite(v)).toBe(true)
  })

  it('null / undefined input is the blank calculator', () => {
    expect(computeRoi(null).inputs).toEqual(normalizeInputs({}))
    expect(computeRoi(undefined).recommended!.plan).toBe('solo')
  })
})

describe('extrapolateToYear', () => {
  it('scales a young workspace\'s totals across 365 days', () => {
    const e = extrapolateToYear({ windowDays: 73, projectsStarted: 4, grantedFreeValue: 2_000 })!
    expect(e.factor).toBeCloseTo(5)
    expect(e.projectsPerYear).toBe(20)
    expect(e.grantedFreeValue).toBe(10_000)
    expect(e.rough).toBe(false)
  })

  it('refuses a full year or more (nothing to project) and a window too short to mean anything', () => {
    expect(extrapolateToYear({ windowDays: 365, projectsStarted: 4, grantedFreeValue: 1 })).toBeNull()
    expect(extrapolateToYear({ windowDays: 900, projectsStarted: 4, grantedFreeValue: 1 })).toBeNull()
    expect(extrapolateToYear({ windowDays: MIN_DAYS_TO_EXTRAPOLATE - 1, projectsStarted: 4, grantedFreeValue: 1 })).toBeNull()
    expect(extrapolateToYear({ windowDays: 0, projectsStarted: 4, grantedFreeValue: 1 })).toBeNull()
    expect(extrapolateToYear({ windowDays: NaN, projectsStarted: 4, grantedFreeValue: 1 })).toBeNull()
  })

  it('a short window is offered but flagged rough', () => {
    expect(extrapolateToYear({ windowDays: ROUGH_EXTRAPOLATION_DAYS - 1, projectsStarted: 1, grantedFreeValue: 0 })!.rough).toBe(true)
    expect(extrapolateToYear({ windowDays: ROUGH_EXTRAPOLATION_DAYS, projectsStarted: 1, grantedFreeValue: 0 })!.rough).toBe(false)
  })

  it('never invents data: zero projects stays null, zero granted-free stays zero, and projects never drop below what was observed', () => {
    const none = extrapolateToYear({ windowDays: 30, projectsStarted: 0, grantedFreeValue: 0 })!
    expect(none.projectsPerYear).toBeNull()
    expect(none.grantedFreeValue).toBe(0)
    expect(extrapolateToYear({ windowDays: 364, projectsStarted: 9, grantedFreeValue: 0 })!.projectsPerYear).toBeGreaterThanOrEqual(9)
  })

  it('garbage input yields null or finite numbers, never NaN', () => {
    const e = extrapolateToYear({ windowDays: 30, projectsStarted: 'x' as any, grantedFreeValue: undefined as any })!
    expect(e.projectsPerYear).toBeNull()
    expect(Number.isFinite(e.grantedFreeValue)).toBe(true)
  })
})

describe('extrapolationFields (the toggle)', () => {
  const m = { windowDays: 73, projectsStarted: 4, grantedFreeValue: 2_000 }
  const recorded = { projectsPerYear: 4, grantedFreeValue: 2_000 }

  it('on projects to a year; off restores exactly the recorded figures (a clean round trip)', () => {
    expect(extrapolationFields(m, recorded, true)).toEqual({ projectsPerYear: 20, grantedFreeValue: 10_000 })
    expect(extrapolationFields(m, recorded, false)).toEqual(recorded)
  })

  it('cannot be switched on when there is nothing to project', () => {
    expect(extrapolationFields({ ...m, windowDays: 365 }, recorded, true)).toBeNull()
    expect(extrapolationFields({ ...m, windowDays: 3 }, recorded, true)).toBeNull()
  })

  it('with no projects recorded the project count is left as it was', () => {
    expect(extrapolationFields({ ...m, projectsStarted: 0 }, { projectsPerYear: 12, grantedFreeValue: 2_000 }, true)!.projectsPerYear).toBe(12)
  })

  it('feeds the model: extrapolated granted-free value becomes the leakage when it beats the estimate', () => {
    const f = extrapolationFields({ windowDays: 30, projectsStarted: 2, grantedFreeValue: 3_000 }, { projectsPerYear: 2, grantedFreeValue: 3_000 }, true)!
    const r = computeRoi({ ...base(), projectsPerYear: f.projectsPerYear, grantedFreeValue: f.grantedFreeValue })
    expect(r.leakedFrom).toBe('measured')
    expect(r.leaked).toBe(Math.round(3_000 * (365 / 30)))
  })
})

describe('ownRecoveryRate', () => {
  it('needs enough flags to mean anything', () => {
    expect(ownRecoveryRate(MIN_FLAGS_FOR_OWN_RATE - 1, 3)).toBeNull()
    expect(ownRecoveryRate(10, 4)).toBeCloseTo(0.4)
    expect(ownRecoveryRate(5, 99)).toBe(1)     // clamped
    expect(ownRecoveryRate(NaN, 1)).toBeNull()
  })
})

describe('drift guards — the model must say what the product really does', () => {
  const marketing = read('components/marketing/MarketingHome.tsx')

  it('seat and project caps come from PLAN_LIMITS, which the pricing table mirrors', () => {
    expect(marketing).toContain("values: ['1', '2', '4', '10']")
    expect(marketing).toContain("values: ['2', '5', 'Unlimited', 'Unlimited']")
    expect([PLAN_LIMITS.solo.seats, PLAN_LIMITS.starter.seats, PLAN_LIMITS.pro.seats, PLAN_LIMITS.agency.seats]).toEqual([1, 2, 4, 10])
    expect([PLAN_LIMITS.solo.projects, PLAN_LIMITS.starter.projects, PLAN_LIMITS.pro.projects, PLAN_LIMITS.agency.projects]).toEqual([2, 5, null, null])
  })

  it('PLAN_FEATURES match the pricing table rows', () => {
    expect(marketing).toContain("label: 'Full SOW history', values: ['Last 10', 'check', 'check', 'check']")
    expect(marketing).toContain("label: 'Custom roles & permissions', values: ['dash', 'dash', 'check', 'check']")
    expect(Object.values(PLAN_FEATURES).map(f => f.fullHistory)).toEqual([false, true, true, true])
    expect(Object.values(PLAN_FEATURES).map(f => f.customRoles)).toEqual([false, false, true, true])
  })

  it('custom-role and export enforcement still agree with the model', () => {
    expect(read('app/api/team/roles/route.ts')).toMatch(/CUSTOM_ROLE_PLANS = \['pro', 'agency', 'trial'\]/)
    expect(read('app/api/invoices/export/route.ts')).toMatch(/solo/)
  })

  it('prices are the same list prices the admin Finance page and Billing cards use', () => {
    expect(LIST_PRICES_USD.solo.monthly).toBe(39)
    expect(read('lib/billing/roi-model.ts')).toContain("from '@/lib/billing/list-prices'")
  })
})

describe('loader — workspace numbers', () => {
  const DAY = 86_400_000
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()
  const proj = (id: string, value: number, status: string, createdDaysAgo: number, currency = 'USD'): Row =>
    ({ id, workspace_id: 'w1', contract_value: value, currency, status, type: 'fixed', deleted_at: null, created_at: iso(createdDaysAgo) })

  const db = () => createFakeSupabase({
    projects: [
      proj('p1', 10_000, 'Active', 20), proj('p2', 20_000, 'Active', 10), proj('p3', 5_000, 'Complete', 5),
      proj('p4', 99_000, 'Active', 8, 'KES'),
    ],
    exceptions_log: [
      { id: 'e1', workspace_id: 'w1', project_id: 'p1', estimated_value: 1_200, deliverable: 'x', created_at: iso(3), projects: { id: 'p1', name: 'P1', currency: 'USD' } },
      { id: 'e2', workspace_id: 'w1', project_id: 'p2', estimated_value: 800, deliverable: 'y', created_at: iso(2), projects: { id: 'p2', name: 'P2', currency: 'USD' } },
    ],
    guardian_flags: [], scope_adjustments: [], amendments: [],
    workspace_members: [
      { id: 'm1', workspace_id: 'w1', status: 'active' }, { id: 'm2', workspace_id: 'w1', status: 'active' },
      { id: 'm3', workspace_id: 'w1', status: 'invited' }, { id: 'm4', workspace_id: 'w2', status: 'active' },
    ],
  })

  it('people who cannot see money get nothing measured and the database is never read', async () => {
    const d = db()
    const spy = vi.spyOn(d.client, 'from')
    const out = await loadRoiInputs(d.client, 'w1', { canSeeMoney: false })
    expect(out).toEqual({ measured: null, defaults: {} })
    expect(spy).not.toHaveBeenCalled()
  })

  it('measures granted-free value, projects started, average value (same currency only), seats and active projects', async () => {
    const out = await loadRoiInputs(db().client, 'w1', { canSeeMoney: true, workspaceCreatedAt: iso(30) })
    const m = out.measured!
    expect(m.currency).toBe('USD')
    expect(m.grantedFreeValue).toBe(2_000)
    expect(m.projectsStarted).toBe(3)                 // p1, p2, p3 — the KES project is another currency
    expect(m.avgProjectValue).toBe(Math.round((10_000 + 20_000 + 5_000) / 3))
    expect(m.activeMembers).toBe(2)                   // invited and other-workspace members excluded
    expect(m.mixedCurrencies).toBe(true)
    expect(out.defaults).toMatchObject({ currency: 'USD', grantedFreeValue: 2_000, seatsNeeded: 2, projectsPerYear: 3 })
  })

  it('the window is the workspace\'s age when younger than a year — nothing is annualised', async () => {
    const out = await loadRoiInputs(db().client, 'w1', { canSeeMoney: true, workspaceCreatedAt: iso(30) })
    expect(out.measured!.windowDays).toBe(30)
    const old = await loadRoiInputs(db().client, 'w1', { canSeeMoney: true, workspaceCreatedAt: iso(900) })
    expect(old.measured!.windowDays).toBe(365)
  })

  it('a failed read surfaces as an error instead of a confident zero', async () => {
    const d = createFakeSupabase({ projects: [], exceptions_log: [], guardian_flags: [], scope_adjustments: [], amendments: [], workspace_members: [] })
    const real = d.client.from.bind(d.client)
    d.client.from = ((t: string) => {
      if (t === 'workspace_members') {
        const q: any = real(t)
        const orig = q.select.bind(q)
        q.select = (...a: any[]) => { const r = orig(...a); r.then = (res: any) => res({ data: null, error: { message: 'boom' }, count: null }); return r }
        return q
      }
      return real(t)
    }) as any
    await expect(loadRoiInputs(d.client, 'w1', { canSeeMoney: true })).rejects.toThrow(/members read failed/)
  })
})

describe('wiring', () => {
  it('the public page is reachable signed-out and carries no workspace data', () => {
    expect(read('middleware.ts')).toMatch(/pathname === '\/calculator'/)
    const page = read('app/calculator/page.tsx')
    expect(page).toMatch(/mode="public" measured=\{null\} defaults=\{\{\}\}/)
    expect(page).not.toMatch(/getSession|createServiceClient/)
  })

  it('the signed-in page gates measured numbers on the Reports rollup permissions and falls back visibly', () => {
    const page = read('app/(app)/plan-calculator/page.tsx')
    expect(page).toMatch(/hasPermission\(session, 'VIEW_FINANCIALS'\) && hasPermission\(session, 'VIEW_ALL_PROJECTS'\)/)
    expect(page).toMatch(/loadFailed/)
    expect(page).toMatch(/redirect\('\/login'\)/)
  })

  it('both calculator permissions survive a lapse, so a read-only workspace can still reach it', () => {
    const plans = read('lib/billing/plans.ts')
    for (const p of ['VIEW_FINANCIALS', 'VIEW_ALL_PROJECTS', 'MANAGE_BILLING']) expect(plans).toContain(`'${p}'`)
  })

  it('entry points: lapsed banner, Billing tab, trial dashboard and the pricing page all link to it', () => {
    expect(read('app/(app)/layout.tsx')).toContain('href="/plan-calculator"')
    expect(read('components/settings/SettingsClient.tsx')).toContain('href="/plan-calculator"')
    expect(read('app/(app)/dashboard/page.tsx')).toContain('href="/plan-calculator"')
    expect(read('components/marketing/MarketingHome.tsx')).toContain('href="/calculator"')
  })

  it('the UI never promises a result and always shows its assumptions', () => {
    const ui = read('components/calculator/PlanCalculator.tsx')
    expect(ui).toMatch(/not a forecast or a guarantee/)
    expect(ui).toMatch(/placeholder starting point, not a benchmark or a promise/)
    expect(ui).not.toMatch(/guaranteed? (return|savings|roi)/i)
  })
})
