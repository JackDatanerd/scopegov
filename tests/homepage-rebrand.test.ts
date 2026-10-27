// tests/homepage-rebrand.test.ts
//
// Guards for the rebranded marketing homepage: the pricing it shows is pinned to the real billing config, the small
// in-page calculator behaves, and every in-page link (nav, dropdowns, footer, CTAs) lands on a section that exists.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { HOME_CALC_DEFAULTS, HOME_PLANS, calcScopeLeak, clampField, fittingPlan, type CalcInputs } from '@/components/marketing/pricing-data'
import { NAV_GROUPS, NAV_LINKS } from '@/components/marketing/NavMenu'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { BLANK_INPUTS, PLAN_FEATURES, computeRoi } from '@/lib/billing/roi-model'
import { calculatorHref, parseCalculatorParams } from '@/lib/billing/roi-url'
import { LIST_PRICES_USD } from '@/lib/billing/list-prices'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('homepage plan data mirrors billing config', () => {
  it('seats, projects, features and prices match PLAN_LIMITS / PLAN_FEATURES / LIST_PRICES_USD', () => {
    for (const p of HOME_PLANS) {
      expect(p.seats, `${p.key} seats`).toBe(PLAN_LIMITS[p.key].seats)
      expect(p.projects, `${p.key} projects`).toBe(PLAN_LIMITS[p.key].projects)
      expect(p.fullHistory, `${p.key} history`).toBe(PLAN_FEATURES[p.key].fullHistory)
      expect(p.customRoles, `${p.key} roles`).toBe(PLAN_FEATURES[p.key].customRoles)
      expect(p.monthly, `${p.key} monthly`).toBe(LIST_PRICES_USD[p.key].monthly)
      expect(p.annual, `${p.key} annual`).toBe(LIST_PRICES_USD[p.key].annual)
    }
  })
  it('"2 months free" is true for every plan', () => {
    for (const p of HOME_PLANS) expect(p.annual).toBe(p.monthly * 10)
  })
})

describe('homepage scope-leak calculator', () => {
  // Same defaults as the full calculator (HOME_CALC_DEFAULTS <- BLANK_INPUTS), with a bigger team so Starter is the fit.
  const base: CalcInputs = { projectsPerYear: 12, avgProjectValue: 5000, creepPct: 22, recoverPct: 72, seats: 2, activeProjects: 4, interval: 'monthly' }
  it('computes leak, recoverable and the fitting plan', () => {
    const r = calcScopeLeak(base)
    expect(r.leaked).toBeCloseTo(13200)
    expect(r.recoverable).toBeCloseTo(9504)
    expect(r.plan?.key).toBe('starter')
    expect(r.net).toBeCloseTo(9504 - 99 * 12)
    expect(r.worthIt).toBe(true)
    expect(r.paybackWeeks).toBe(Math.ceil((1188 / 9504) * 52))
  })
  it('the plan cost follows the billing interval instead of always being monthly x 12', () => {
    const annual = calcScopeLeak({ ...base, interval: 'annual' })
    expect(annual.annualCost).toBe(990)
    expect(annual.net).toBeCloseTo(9504 - 990)
  })
  it('says "not yet" instead of inflating the result', () => {
    const r = calcScopeLeak({ ...base, avgProjectValue: 200 })
    expect(r.worthIt).toBe(false)
    expect(r.paybackWeeks).toBeNull()
  })
  it('no plan above 10 seats; project caps and features respected', () => {
    expect(fittingPlan(11, 1)).toBeNull()
    expect(calcScopeLeak({ ...base, seats: 11 }).plan).toBeNull()
    expect(fittingPlan(1, 3)?.key).toBe('starter')
    expect(fittingPlan(2, 6)?.key).toBe('pro')
    expect(fittingPlan(1, 2, { customRoles: true })?.key).toBe('pro')
    expect(fittingPlan(1, 2, { fullHistory: true })?.key).toBe('starter')
    expect(calcScopeLeak({ ...base, seats: 1, activeProjects: 1, needsCustomRoles: true }).plan?.key).toBe('pro')
  })
  it('blank or junk fields clamp to the minimum, out-of-range values clamp into range', () => {
    expect(clampField('', 1, 500)).toBe(1)
    expect(clampField('abc', 0, 40)).toBe(0)
    expect(clampField('999', 0, 40)).toBe(40)
    expect(clampField('-5', 0, 40)).toBe(0)
  })
})

describe('homepage calculator and the full calculator agree (Billing / trial-end audit)', () => {
  it('start from the same defaults', () => {
    expect(HOME_CALC_DEFAULTS.projectsPerYear).toBe(BLANK_INPUTS.projectsPerYear)
    expect(HOME_CALC_DEFAULTS.avgProjectValue).toBe(BLANK_INPUTS.avgProjectValue)
    expect(HOME_CALC_DEFAULTS.creepPct).toBe(BLANK_INPUTS.creepPct)
    expect(HOME_CALC_DEFAULTS.recoverPct).toBe(Math.round(BLANK_INPUTS.recoveryRate * 100))
    expect(HOME_CALC_DEFAULTS.seats).toBe(BLANK_INPUTS.seatsNeeded)
    expect(HOME_CALC_DEFAULTS.activeProjects).toBe(BLANK_INPUTS.activeProjectsNeeded)
    expect(HOME_CALC_DEFAULTS.annual).toBe(BLANK_INPUTS.interval === 'annual')
  })
  it('give the same plan, recoverable amount and net for the same inputs', () => {
    const cases = [
      { projectsPerYear: 12, avgProjectValue: 5000, creepPct: 10, recoverPct: 68, seats: 1, activeProjects: 2 },
      { projectsPerYear: 30, avgProjectValue: 8000, creepPct: 25, recoverPct: 50, seats: 3, activeProjects: 9 },
      { projectsPerYear: 4, avgProjectValue: 1200, creepPct: 5, recoverPct: 40, seats: 2, activeProjects: 3, needsFullHistory: true },
    ]
    for (const c of cases) for (const interval of ['monthly', 'annual'] as const) {
      const home = calcScopeLeak({ ...c, interval })
      const full = computeRoi({
        projectsPerYear: c.projectsPerYear, avgProjectValue: c.avgProjectValue, creepPct: c.creepPct, grantedFreeValue: 0,
        recoveryRate: c.recoverPct / 100, seatsNeeded: c.seats, activeProjectsNeeded: c.activeProjects,
        needsCustomRoles: false, needsFullHistory: !!(c as any).needsFullHistory, interval, currency: 'USD', fxToUsd: null,
      })
      expect(home.plan?.key).toBe(full.recommended?.plan)
      expect(home.recoverable).toBeCloseTo(full.recoverable)
      expect(home.net).toBeCloseTo(full.recommended!.net!)
      expect(home.worthIt).toBe(full.verdict === 'worth_it')
    }
  })
  it('the homepage hands its numbers to /calculator through the URL and the calculator reads them back', () => {
    const inputs = { projectsPerYear: 30, avgProjectValue: 8000, creepPct: 25, recoverPct: 50, seats: 3, activeProjects: 9, interval: 'monthly' as const, needsCustomRoles: true }
    const href = calculatorHref(inputs)
    expect(href.startsWith('/calculator?')).toBe(true)
    const parsed = parseCalculatorParams(new URL(href, 'https://x.test').searchParams)
    expect(parsed).toMatchObject({ projectsPerYear: 30, avgProjectValue: 8000, creepPct: 25, recoveryRate: 0.5, seatsNeeded: 3, activeProjectsNeeded: 9, interval: 'monthly', needsCustomRoles: true })
    expect(parsed.needsFullHistory).toBeUndefined()
  })
  it('URL values are clamped and junk is ignored', () => {
    const parsed = parseCalculatorParams({ projects: '999999', creep: '500', rec: '-20', seats: 'abc', value: '', interval: 'weekly' })
    expect(parsed.projectsPerYear).toBe(10_000)
    expect(parsed.creepPct).toBe(100)
    expect(parsed.recoveryRate).toBe(0)
    expect('seatsNeeded' in parsed).toBe(false)
    expect('avgProjectValue' in parsed).toBe(false)
    expect('interval' in parsed).toBe(false)
    expect(parseCalculatorParams({})).toEqual({})
  })
})

describe('homepage in-page links all resolve', () => {
  const home = read('components/marketing/MarketingHome.tsx')
  const ids = new Set([...home.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]))
  const hrefs = new Set<string>()
  for (const g of NAV_GROUPS) for (const i of g.items) hrefs.add(i.href)
  for (const l of NAV_LINKS) hrefs.add(l.href)
  for (const f of ['MarketingHome', 'MarketingHeader', 'MarketingFooter', 'PricingSection', 'ScopeCategories', 'MobileCta'])
    for (const m of read(`components/marketing/${f}.tsx`).matchAll(/href="#([\w-]+)"/g)) hrefs.add('#' + m[1])

  it('every #anchor points at an element id on the page', () => {
    for (const h of hrefs) expect(ids.has(h.slice(1)) || h === '#top' || h === '#hero', h).toBe(true)
  })
  it('no two elements share an id', () => {
    const all = [...home.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1])
    expect(new Set(all).size).toBe(all.length)
  })
  it('the sections the old homepage had are still reachable from the nav', () => {
    const navHrefs = [...NAV_GROUPS.flatMap((g) => g.items), ...NAV_LINKS].map((i) => i.href)
    for (const h of ['#how', '#guardian', '#features', '#portfolio', '#pricing', '#faq']) expect(navHrefs).toContain(h)
  })
})

describe('hero headline underline', () => {
  const home = read('components/marketing/MarketingHome.tsx')
  const css = read('styles/marketing.module.css')
  it('the per-word split still spells the headline phrase', () => {
    const m = home.match(/const REDLINE_WORDS = \[(.*?)\]/)!
    const words = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    expect(words.join(' ')).toBe('Most agencies never send one.')
  })
  it('the draw-in respects reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:reduce\)\{\.rlWord::after\{animation:none;clip-path:none\}/)
  })
})
