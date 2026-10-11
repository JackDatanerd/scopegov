// tests/homepage-rebrand.test.ts
//
// Guards for the rebranded marketing homepage: the pricing it shows is pinned to the real billing config, the small
// in-page calculator behaves, and every in-page link (nav, dropdowns, footer, CTAs) lands on a section that exists.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { HOME_PLANS, calcScopeLeak, clampField, fittingPlan, type CalcInputs } from '@/components/marketing/pricing-data'
import { NAV_GROUPS, NAV_LINKS } from '@/components/marketing/NavMenu'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { PLAN_FEATURES } from '@/lib/billing/roi-model'
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
  const base: CalcInputs = { projectsPerYear: 12, avgProjectValue: 5000, creepPct: 22, recoverPct: 72, seats: 2, activeProjects: 4 }
  it('computes leak, recoverable and the fitting plan', () => {
    const r = calcScopeLeak(base)
    expect(r.leaked).toBe(13200)
    expect(r.recoverable).toBeCloseTo(9504)
    expect(r.plan?.key).toBe('starter')
    expect(r.net).toBeCloseTo(9504 - 99 * 12)
    expect(r.worthIt).toBe(true)
    expect(r.paybackWeeks).toBe(Math.ceil((1188 / 9504) * 52))
  })
  it('says "not yet" instead of inflating the result', () => {
    const r = calcScopeLeak({ ...base, avgProjectValue: 200 })
    expect(r.worthIt).toBe(false)
    expect(r.paybackWeeks).toBeNull()
  })
  it('no plan above 10 seats; project caps respected', () => {
    expect(fittingPlan(11, 1)).toBeNull()
    expect(calcScopeLeak({ ...base, seats: 11 }).plan).toBeNull()
    expect(fittingPlan(1, 3)?.key).toBe('starter')
    expect(fittingPlan(2, 6)?.key).toBe('pro')
  })
  it('blank or junk fields clamp to the minimum, out-of-range values clamp into range', () => {
    expect(clampField('', 1, 500)).toBe(1)
    expect(clampField('abc', 0, 40)).toBe(0)
    expect(clampField('999', 0, 40)).toBe(40)
    expect(clampField('-5', 0, 40)).toBe(0)
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
