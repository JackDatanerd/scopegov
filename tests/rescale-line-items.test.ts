import { describe, it, expect } from 'vitest'
import { rescaleLineItemsToTotal, type RescaleLineItem } from '@/lib/utils/rescale-line-items'

const items = (): RescaleLineItem[] => [
  { id: '1', description: 'Design', quantity: 10, rate: 100, total: 1000 },
  { id: '2', description: 'Dev', quantity: 20, rate: 150, total: 3000 },
]
// oldSubtotal = 4000

describe('rescaleLineItemsToTotal', () => {
  it('leaves every original line item untouched — rate, quantity, and total', () => {
    const result = rescaleLineItemsToTotal(items(), 2000, 0, false)
    const [design, dev] = result.lineItems
    expect(design).toMatchObject({ description: 'Design', quantity: 10, rate: 100, total: 1000 })
    expect(dev).toMatchObject({ description: 'Dev', quantity: 20, rate: 150, total: 3000 })
  })

  it('appends a negative discount line for the negotiated-down difference, and the whole set sums to the new subtotal', () => {
    const result = rescaleLineItemsToTotal(items(), 2000, 0, false)
    expect(result.lineItems).toHaveLength(3)
    const discountLine = result.lineItems[2]
    expect(discountLine.description).toBe('Negotiated discount (per counter-offer)')
    expect(discountLine.total).toBe(-2000)
    const sum = result.lineItems.reduce((s, li) => s + li.total, 0)
    expect(sum).toBeCloseTo(result.subtotal, 2)
    expect(result.subtotal).toBe(2000)
    expect(result.total).toBe(2000)
  })

  it('appends a positive increase line when the negotiated total is higher than the original', () => {
    const result = rescaleLineItemsToTotal(items(), 4500, 0, false)
    const increaseLine = result.lineItems[2]
    expect(increaseLine.description).toBe('Negotiated increase (per counter-offer)')
    expect(increaseLine.total).toBe(500)
    expect(result.subtotal).toBe(4500)
  })

  it('adds no adjustment line when the negotiated total exactly matches the original', () => {
    const result = rescaleLineItemsToTotal(items(), 4000, 0, false)
    expect(result.lineItems).toHaveLength(2)
    expect(result.subtotal).toBe(4000)
  })

  it('back-solves subtotal from a tax-exclusive negotiated total', () => {
    // newTotal 2200 at 10% exclusive tax → subtotal should be 2000
    const result = rescaleLineItemsToTotal(items(), 2200, 10, false)
    expect(result.subtotal).toBeCloseTo(2000, 2)
    expect(result.total).toBe(2200)
    const sum = result.lineItems.reduce((s, li) => s + li.total, 0)
    expect(sum).toBeCloseTo(result.subtotal, 2)
  })

  it('treats a tax-inclusive total as the subtotal directly', () => {
    const result = rescaleLineItemsToTotal(items(), 2200, 10, true)
    expect(result.subtotal).toBe(2200)
  })

  it('falls back to one synthetic line item when the original subtotal is zero', () => {
    const unpriced: RescaleLineItem[] = [
      { id: '1', description: 'TBD', quantity: 1, rate: 0, total: 0 },
    ]
    const result = rescaleLineItemsToTotal(unpriced, 1500, 0, false)
    expect(result.lineItems).toHaveLength(1)
    expect(result.lineItems[0].total).toBe(1500)
    expect(result.subtotal).toBe(1500)
  })

  it('treats an all-zero-quantity original subtotal the same as unpriced — falls back to one synthetic line', () => {
    const withZeroQty: RescaleLineItem[] = [
      { id: '1', description: 'Flat fee', quantity: 0, rate: 500, total: 0 },
    ]
    expect(() => rescaleLineItemsToTotal(withZeroQty, 2000, 0, false)).not.toThrow()
    const result = rescaleLineItemsToTotal(withZeroQty, 2000, 0, false)
    expect(result.lineItems).toHaveLength(1)
  })

  it('a zero-quantity line alongside priced lines is preserved as-is, not divided by zero', () => {
    const withZeroQty: RescaleLineItem[] = [
      { id: '1', description: 'Flat fee', quantity: 0, rate: 500, total: 0 },
      { id: '2', description: 'Hours', quantity: 10, rate: 100, total: 1000 },
    ]
    expect(() => rescaleLineItemsToTotal(withZeroQty, 2000, 0, false)).not.toThrow()
    const result = rescaleLineItemsToTotal(withZeroQty, 2000, 0, false)
    expect(result.lineItems[0]).toMatchObject({ description: 'Flat fee', quantity: 0, rate: 500, total: 0 })
    expect(result.lineItems[1]).toMatchObject({ description: 'Hours', quantity: 10, rate: 100, total: 1000 })
  })
})
