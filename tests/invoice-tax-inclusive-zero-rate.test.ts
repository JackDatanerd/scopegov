import { describe, it, expect } from 'vitest'
import { computeInvoiceTotals } from '@/lib/documents/invoice-totals'
import { isPaymentClaimOpen } from '@/lib/utils/invoice-registry'

describe('invoice tax_inclusive with no tax rate', () => {
  it('forces taxInclusive false when the rate is 0, even if the caller sends true', () => {
    const r: any = computeInvoiceTotals({ entered: 1000, taxRate: 0, taxInclusive: true } as any)
    expect(r.ok).toBe(true)
    expect(r.totals.taxInclusive).toBe(false)
    expect(r.totals.amount).toBe(1000)
    expect(r.totals.subtotal).toBe(1000)
  })
  it('forces taxInclusive false when the rate is omitted and only inherited', () => {
    const r: any = computeInvoiceTotals({ entered: 500, inherited: { taxRate: 0, taxInclusive: true } } as any)
    expect(r.ok).toBe(true)
    expect(r.totals.taxInclusive).toBe(false)
  })
  it('still honours taxInclusive when a real rate is set', () => {
    const r: any = computeInvoiceTotals({ entered: 1100, taxRate: 10, taxInclusive: true } as any)
    expect(r.ok).toBe(true)
    expect(r.totals.taxInclusive).toBe(true)
    expect(r.totals.amount).toBe(1100)
  })
})

describe('isPaymentClaimOpen', () => {
  it('is closed with no claim', () => expect(isPaymentClaimOpen({})).toBe(false))
  it('is open with an uncleared claim', () =>
    expect(isPaymentClaimOpen({ payment_claimed_at: '2026-09-01T00:00:00Z' })).toBe(true))
  it('is closed when cleared after the claim', () =>
    expect(isPaymentClaimOpen({ payment_claimed_at: '2026-09-01T00:00:00Z', payment_claim_cleared_at: '2026-09-02T00:00:00Z' })).toBe(false))
  it('is open when the clear predates a newer claim', () =>
    expect(isPaymentClaimOpen({ payment_claimed_at: '2026-09-05T00:00:00Z', payment_claim_cleared_at: '2026-09-02T00:00:00Z' })).toBe(true))
})
