import { describe, it, expect } from 'vitest'
import { rescaleLineItemsToTotal, type RescaleLineItem } from '@/lib/utils/rescale-line-items'

const items = (): RescaleLineItem[] => [
  { id: '1', description: 'Design', quantity: 10, rate: 100, total: 1000 },
  { id: '2', description: 'Dev', quantity: 20, rate: 150, total: 3000 },
]
// oldSubtotal = 4000

describe('rescaleLineItemsToTotal', () => {
  it('scales line items proportionally and always sums exactly to the new subtotal (no tax)', () => {
    const result = rescaleLineItemsToTotal(items(), 2000, 0, false)
    const sum = result.lineItems.reduce((s, li) => s + li.total, 0)
    expect(sum).toBeCloseTo(result.subtotal, 2)
    expect(result.subtotal).toBe(2000)
    expect(result.total).toBe(2000)
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

  it('rounding drift is absorbed by the last line item, never left dangling', () => {
    // A ratio that produces per-line rounding remainders (1/3-style split)
    const threeItems: RescaleLineItem[] = [
      { id: '1', description: 'A', quantity: 3, rate: 33.33, total: 99.99 },
      { id: '2', description: 'B', quantity: 7, rate: 33.33, total: 233.31 },
      { id: '3', description: 'C', quantity: 11, rate: 33.33, total: 366.63 },
    ]
    const result = rescaleLineItemsToTotal(threeItems, 500, 0, false)
    const sum = result.lineItems.reduce((s, li) => s + li.total, 0)
    expect(sum).toBe(result.subtotal)
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

  it('handles a zero-quantity line item without dividing by zero', () => {
    const withZeroQty: RescaleLineItem[] = [
      { id: '1', description: 'Flat fee', quantity: 0, rate: 500, total: 0 },
      { id: '2', description: 'Hours', quantity: 10, rate: 100, total: 1000 },
    ]
    expect(() => rescaleLineItemsToTotal(withZeroQty, 2000, 0, false)).not.toThrow()
  })
})
