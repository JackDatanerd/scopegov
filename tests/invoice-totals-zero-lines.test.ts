import { describe, it, expect } from 'vitest'
import { computeInvoiceTotals } from '@/lib/documents/invoice-totals'

describe('computeInvoiceTotals — itemized invoices must total more than 0', () => {
  it('rejects all-zero line totals with a readable error (was an opaque 500 from the amount > 0 CHECK)', () => {
    const r = computeInvoiceTotals({
      entered: undefined, taxRate: 0, taxInclusive: false,
      lineItems: [{ description: 'Hypercare support', quantity: 62, rate: 0 }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/more than 0/)
  })

  it('still accepts a normal itemized invoice', () => {
    const r = computeInvoiceTotals({
      entered: undefined, taxRate: 0, taxInclusive: false,
      lineItems: [{ description: 'Hypercare support', quantity: 2, rate: 145 }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.totals.amount).toBe(290)
  })
})
