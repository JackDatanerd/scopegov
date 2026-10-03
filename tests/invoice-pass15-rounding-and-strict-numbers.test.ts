import { describe, it, expect } from 'vitest'
import { computeInvoiceTotals, toStrictNumber } from '@/lib/documents/invoice-totals'
import { lineTotal, itemizedSubtotal } from '@/lib/documents/invoice-form'

describe('B1 — the form footing equals the server footing', () => {
  const lines = [
    { description: 'a', quantity: 2.5, rate: 19.99 },
    { description: 'b', quantity: 2.5, rate: 19.99 },
    { description: 'c', quantity: 2.5, rate: 19.99 },
  ]
  it('itemizedSubtotal rounds each line first, like the server', () => {
    // 2.5 × 19.99 is exactly 49.975 → half-up 49.98 (the float product 49.97499… used to round DOWN to 49.97)
    expect(lineTotal(2.5, 19.99)).toBe(49.98)
    expect(itemizedSubtotal(lines)).toBe(149.94)
  })
  it('the amount the form sends is accepted by computeInvoiceTotals', () => {
    const r = computeInvoiceTotals({ entered: itemizedSubtotal(lines), taxRate: 0, taxInclusive: false, lineItems: lines })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.totals.amount).toBe(149.94)
  })
  it('four lines of 10.005 also foot', () => {
    const l = Array.from({ length: 4 }, (_, i) => ({ description: 'x' + i, quantity: 1, rate: 10.005 }))
    expect(computeInvoiceTotals({ entered: itemizedSubtotal(l), taxRate: 0, taxInclusive: false, lineItems: l }).ok).toBe(true)
  })
  it('ignores rows without a description', () => {
    expect(itemizedSubtotal([{ description: ' ', quantity: 5, rate: 5 }, { description: 'a', quantity: 1, rate: 2 }])).toBe(2)
  })
})

describe('L1 — strict numeric input', () => {
  it('toStrictNumber', () => {
    expect(toStrictNumber(5)).toBe(5)
    expect(toStrictNumber(' 12.5 ')).toBe(12.5)
    for (const bad of [true, false, null, undefined, '', '  ', [5], {}]) expect(Number.isNaN(toStrictNumber(bad))).toBe(true)
  })
  it('rejects boolean / array / null amounts', () => {
    for (const entered of [true, [5], null]) {
      const r = computeInvoiceTotals({ entered, taxRate: 0, taxInclusive: false })
      expect(r.ok).toBe(false)
    }
  })
  it('rejects boolean tax rate and non-numeric line quantity / rate', () => {
    expect(computeInvoiceTotals({ entered: 10, taxRate: true, taxInclusive: false }).ok).toBe(false)
    const bad = (quantity: unknown, rate: unknown) =>
      computeInvoiceTotals({ entered: undefined, taxRate: 0, taxInclusive: false, lineItems: [{ description: 'a', quantity, rate }] }).ok
    expect(bad(true, 5)).toBe(false)
    expect(bad(2, null)).toBe(false)
    expect(bad(2, [5])).toBe(false)
    expect(bad(2, 5)).toBe(true)
  })
  it('still accepts numeric strings and the normal cases', () => {
    const r = computeInvoiceTotals({ entered: '100', taxRate: '16', taxInclusive: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.totals.amount).toBe(116)
  })
})
