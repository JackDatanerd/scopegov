import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CURRENT_RATE_LABEL, isOpenEndedRetainer, withCurrentRateLine, withoutCurrentRateLine, monthlyRateFromCo,
} from '@/lib/documents/co-retainer'

const read = (p: string) => readFileSync(p, 'utf8')
const line = (id: string, description: string, rate = 0) => ({ id, description, quantity: 1, rate, total: rate })

describe('open-ended retainer', () => {
  it('is a retainer with no positive term', () => {
    expect(isOpenEndedRetainer({ type: 'retainer', retainer_duration_months: null })).toBe(true)
    expect(isOpenEndedRetainer({ type: 'retainer', retainer_duration_months: 0 })).toBe(true)
    expect(isOpenEndedRetainer({ type: 'retainer' })).toBe(true)
    expect(isOpenEndedRetainer({ type: 'retainer', retainer_duration_months: 12 })).toBe(false)
    expect(isOpenEndedRetainer({ type: 'marketing', retainer_duration_months: null })).toBe(false)
    expect(isOpenEndedRetainer(null)).toBe(false)
  })
})

describe('the current monthly rate is the first line of a monthly-rate change order', () => {
  it('prepends it once, replacing an untouched empty starter row', () => {
    const out = withCurrentRateLine([line('a', '')], 1200, 'new')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'new', description: CURRENT_RATE_LABEL, quantity: 1, rate: 1200, total: 1200 })
    expect(withCurrentRateLine(out, 1200, 'again')).toBe(out) // never twice
  })
  it('keeps what the person already wrote, after the current rate', () => {
    const out = withCurrentRateLine([line('a', 'Hooks and on-screen copy', 200)], 1200, 'new')
    expect(out.map(l => l.description)).toEqual([CURRENT_RATE_LABEL, 'Hooks and on-screen copy'])
  })
  it('does nothing when the rate is unknown, hidden or zero', () => {
    const lines = [line('a', '')]
    expect(withCurrentRateLine(lines, null, 'n')).toBe(lines)
    expect(withCurrentRateLine(lines, 0, 'n')).toBe(lines)
    expect(withCurrentRateLine(lines, undefined, 'n')).toBe(lines)
  })
  it('un-ticking removes only that line', () => {
    const lines = [line('x', CURRENT_RATE_LABEL, 1200), line('a', 'Scripts', 100)]
    expect(withoutCurrentRateLine(lines).map(l => l.id)).toEqual(['a'])
  })
})

describe('the monthly rate a change order sets', () => {
  it('tax included: the total, which already contains the tax', () => {
    expect(monthlyRateFromCo({ total: 1600, subtotal: 1478.07, tax_inclusive: true })).toBe(1600)
  })
  it('tax added on top: the subtotal, because the monthly invoice adds the tax itself', () => {
    expect(monthlyRateFromCo({ total: 1856, subtotal: 1600, tax_inclusive: false })).toBe(1600)
  })
  it('no tax, or an old row without a subtotal: the total', () => {
    expect(monthlyRateFromCo({ total: 1600, subtotal: 1600, tax_inclusive: false })).toBe(1600)
    expect(monthlyRateFromCo({ total: 1600, subtotal: null, tax_inclusive: false })).toBe(1600)
    expect(monthlyRateFromCo({ total: '1600', tax_inclusive: null })).toBe(1600)
  })
})

describe('wiring', () => {
  it('acceptance, the executed PDF and both live PDFs use the same rate', () => {
    const fin = read('lib/documents/finalize-co.ts')
    expect(fin).toContain('contract_value: monthlyRateFromCo(co)')
    expect(fin).toContain('new_monthly_amount: monthlyRateFromCo(co)')
    expect(fin).toContain('const revisedContractValue = isRenewal ? monthlyRateFromCo(co) : null')
    expect(read('app/api/pdf/co/[id]/route.ts')).toContain('revisedContractValue: isRenewalCo ? monthlyRateFromCo(co) : null')
    expect(read('app/api/portal/co/[token]/pdf/route.ts')).toContain('revisedContractValue: isRenewalCo ? monthlyRateFromCo(co) : null')
  })
  it('an open-ended retainer never stores a timeline impact, on create, edit or draft', () => {
    expect(read('app/api/co/route.ts')).toContain('timeline_impact_days: isOpenEndedRetainer(project) ? null')
    expect(read('app/api/co/[id]/route.ts')).toContain("if ('timeline_impact_days' in update) update.timeline_impact_days = null")
    expect(read('app/api/co/draft/route.ts')).toContain('!isOpenEndedRetainer(project) && Number.isInteger(days)')
  })
  it('the editor offers the monthly-rate change, shows the current rate first, and hides timeline fields on an open-ended retainer', () => {
    const src = read('components/co/CoEditor.tsx')
    expect(src).toContain('This changes the monthly rate (a renewal, or extra monthly work)')
    expect(src).toContain('onToggleMonthlyRate(e.target.checked)')
    expect(src).toContain('The first line is the current monthly retainer')
    expect(src).toContain('{!retainerOpenEnded && (<>')
    expect(src).toContain('withCurrentRateLine(drafted, currentRate, nanoid())')
  })
  it('the CO PDF keeps its totals together and says the subtotal is before tax when lines include it', () => {
    const src = read('lib/pdf/renderer.tsx')
    expect(src).toContain('<View style={s.totals} wrap={false}>')
    expect(src).toContain("'Subtotal before tax'")
  })
})
