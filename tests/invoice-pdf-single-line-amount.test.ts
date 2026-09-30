import { describe, it, expect } from 'vitest'
import { invoiceSingleLineAmount } from '@/lib/pdf/invoice-line'
import { computeInvoiceTotals } from '@/lib/documents/invoice-totals'

describe('invoice PDF single line amount', () => {
  it('tax-exclusive: prints the net so line + tax = amount due', () => {
    const r: any = computeInvoiceTotals({ entered: 1000, taxRate: 16, taxInclusive: false } as any)
    expect(r.ok).toBe(true)
    const t = r.totals
    const line = invoiceSingleLineAmount(t)
    expect(line).toBe(1000)
    expect(Math.round((line + (t.amount - t.subtotal)) * 100) / 100).toBe(t.amount)
  })
  it('tax-inclusive: prints the gross', () => {
    const r: any = computeInvoiceTotals({ entered: 1160, taxRate: 16, taxInclusive: true } as any)
    expect(invoiceSingleLineAmount(r.totals)).toBe(1160)
  })
  it('no tax: prints the amount', () => {
    expect(invoiceSingleLineAmount({ amount: 500, subtotal: 500, taxRate: 0, taxInclusive: false })).toBe(500)
  })
  it('legacy row with tax but no stored subtotal falls back to amount', () => {
    expect(invoiceSingleLineAmount({ amount: 1160, subtotal: null, taxRate: 16, taxInclusive: false })).toBe(1160)
  })
  it('legacy tax_rate 0 + tax_inclusive true prints the amount', () => {
    expect(invoiceSingleLineAmount({ amount: 700, subtotal: 700, taxRate: 0, taxInclusive: true })).toBe(700)
  })
})
