import { describe, it, expect } from 'vitest'
import {
  computeInvoiceTotals, enteredAmountOf, parsePaymentInstructions, MAX_PAYMENT_INSTRUCTIONS_LEN,
} from '@/lib/documents/invoice-totals'

// The PATCH route decides what to hand computeInvoiceTotals as `entered`. These pin the contract it relies on:
// a line-item-only edit must pass `entered: undefined` (no stale stored amount to cross-check against).
describe('line-item-only edit of an existing invoice (pass 11)', () => {
  const stored = { amount: 100, subtotal: 100, tax_rate: 0, tax_inclusive: false }
  const newItems = [{ description: 'Extra work', quantity: 2, rate: 75 }]

  it('the stale stored amount as `entered` is (correctly) rejected by the cross-check — the route must not pass it', () => {
    const r = computeInvoiceTotals({ entered: enteredAmountOf(stored), taxRate: 0, taxInclusive: false, lineItems: newItems })
    expect(r.ok).toBe(false)
  })

  it('with `entered: undefined` the new line sum becomes the amount', () => {
    const r = computeInvoiceTotals({ entered: undefined, taxRate: 0, taxInclusive: false, lineItems: newItems })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.totals.amount).toBe(150); expect(r.totals.subtotal).toBe(150) }
  })

  it('taxed line-item-only edit grosses up from the line sum', () => {
    const r = computeInvoiceTotals({ entered: undefined, taxRate: 16, taxInclusive: false, lineItems: newItems })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.totals.subtotal).toBe(150); expect(r.totals.amount).toBe(174) }
  })

  it('an unchanged itemized invoice re-fed its own stored net still passes the cross-check', () => {
    const itemized = { amount: 174, subtotal: 150, tax_rate: 16, tax_inclusive: false }
    const r = computeInvoiceTotals({ entered: enteredAmountOf(itemized), taxRate: 16, taxInclusive: false, lineItems: newItems })
    expect(r.ok).toBe(true)
  })
})

describe('parsePaymentInstructions (pass 11)', () => {
  it('treats undefined / null / blank rich text as null', () => {
    expect(parsePaymentInstructions(undefined)).toEqual({ ok: true, value: null })
    expect(parsePaymentInstructions(null)).toEqual({ ok: true, value: null })
    expect(parsePaymentInstructions('<p></p>')).toEqual({ ok: true, value: null })
  })
  it('rejects non-string input', () => {
    for (const bad of [5, {}, [], true]) expect(parsePaymentInstructions(bad).ok).toBe(false)
  })
  it('rejects over-long input and accepts input at the cap', () => {
    expect(parsePaymentInstructions('a'.repeat(MAX_PAYMENT_INSTRUCTIONS_LEN + 1)).ok).toBe(false)
    expect(parsePaymentInstructions('a'.repeat(MAX_PAYMENT_INSTRUCTIONS_LEN)).ok).toBe(true)
  })
  it('sanitises markup', () => {
    const r = parsePaymentInstructions('<p>Bank: 123</p><script>alert(1)</script>')
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.value).toContain('Bank: 123'); expect(r.value).not.toContain('<script') }
  })
})
