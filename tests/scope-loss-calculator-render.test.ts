// Render smoke test: the calculator component must actually mount and show the right things in each mode —
// the source-reading tests cannot catch a runtime error or a wrong CTA.
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/link', () => ({ default: (p: any) => createElement('a', { href: p.href, className: p.className }, p.children) }))

import PlanCalculator from '@/components/calculator/PlanCalculator'
import type { MeasuredNumbers } from '@/lib/billing/roi-inputs'

const measured: MeasuredNumbers = {
  currency: 'USD', mixedCurrencies: false, windowDays: 365, grantedFreeValue: 6_000, recoveredValue: 2_500,
  totalFlags: 10, convertedToCo: 4, ownRecoveryRate: 0.4, projectsStarted: 8, avgProjectValue: 12_000,
  activeProjects: 3, activeMembers: 2, truncated: false,
}
const html = (props: any) => renderToStaticMarkup(createElement(PlanCalculator, props))

describe('PlanCalculator render', () => {
  it('public mode: blank, a signup CTA for the recommended plan, no workspace section', () => {
    const out = html({ mode: 'public', measured: null, defaults: {} })
    expect(out).toContain('What is scope creep costing you?')
    expect(out).toContain('href="/signup?plan=solo"')
    expect(out).not.toContain('From your workspace')
    expect(out).toContain('25')                                   // default recovery rate shown
    expect(out).toContain('not a forecast or a guarantee')
  })

  it('app mode: shows the workspace\'s measured numbers, its own recovery rate, and the billing CTA only for billing holders', () => {
    const defaults = { currency: 'USD', grantedFreeValue: 6_000, seatsNeeded: 2, activeProjectsNeeded: 3, projectsPerYear: 8, avgProjectValue: 12_000 }
    const withBilling = html({ mode: 'app', measured, defaults, canManageBilling: true })
    expect(withBilling).toContain('From your workspace')
    expect(withBilling).toContain('Use that rate')
    expect(withBilling).toContain('(40%)')
    expect(withBilling).toContain('href="/settings?tab=billing"')
    expect(withBilling).toContain('Starter')                      // 2 seats, 3 active projects → Starter is the smallest fit
    const without = html({ mode: 'app', measured, defaults, canManageBilling: false })
    expect(without).not.toContain('href="/settings?tab=billing"')
    expect(without).toContain('Ask a workspace admin')
  })

  it('app mode without measured numbers (no financial access) renders the manual calculator, not a zeroed workspace', () => {
    const out = html({ mode: 'app', measured: null, defaults: {}, canManageBilling: true })
    expect(out).not.toContain('From your workspace')
    expect(out).toContain('Your work')
  })

  it('a non-USD workspace is asked for an exchange rate and shown no net until it has one', () => {
    const out = html({ mode: 'app', measured: { ...measured, currency: 'KES' }, defaults: { currency: 'KES', seatsNeeded: 1, activeProjectsNeeded: 1 }, canManageBilling: true })
    expect(out).toContain('1 KES = how many USD?')
    expect(out).toContain('add an exchange rate to compare costs')
    expect(out).not.toContain('Estimated net per year')
  })

  it('warns when the workspace is young and when reads were truncated', () => {
    const out = html({ mode: 'app', measured: { ...measured, windowDays: 12, truncated: true }, defaults: {}, canManageBilling: true })
    expect(out).toContain('only 12 days old')
    expect(out).toContain('may be slightly low')
  })
})
