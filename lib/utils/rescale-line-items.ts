// lib/utils/rescale-line-items.ts
//
// FIX (doc-completeness audit, finding #5): when a client counter-offers
// on a change order and the agency accepts, the CO's `total` was being
// overwritten to the negotiated amount while `subtotal` and `line_items`
// stayed at their pre-negotiation values. The rendered PDF/portal then
// showed line items and a subtotal that didn't sum to the stated total,
// and tax computed off the stale subtotal — a visibly broken legal
// document. This proportionally rescales every line item's rate/total
// (keeping quantity fixed) so the itemization always reconciles exactly
// with the new negotiated total, under the same taxRate/taxInclusive
// rules used everywhere else (CoEditor, renderer.tsx, portal page).

import { nanoid } from 'nanoid'

export interface RescaleLineItem {
  id: string
  description: string
  quantity: number
  rate: number
  total: number
}

export interface RescaleResult {
  lineItems: RescaleLineItem[]
  subtotal: number
  total: number
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Rescales lineItems so they sum exactly to the subtotal implied by
 * newTotal (back-solving out tax when not tax-inclusive), and returns
 * the new subtotal/total to store alongside them.
 */
export function rescaleLineItemsToTotal(
  lineItems: RescaleLineItem[],
  newTotal: number,
  taxRate: number,
  taxInclusive: boolean
): RescaleResult {
  const safeTaxRate = taxRate || 0
  const newSubtotal = taxInclusive || safeTaxRate === 0
    ? newTotal
    : newTotal / (1 + safeTaxRate / 100)

  const oldSubtotal = lineItems.reduce((s, li) => s + (li.quantity * li.rate), 0)

  let rescaled: RescaleLineItem[]

  if (oldSubtotal > 0) {
    const ratio = newSubtotal / oldSubtotal
    rescaled = lineItems.map(li => {
      const newItemTotal = round2(li.quantity * li.rate * ratio)
      const newRate = li.quantity !== 0 ? round2(newItemTotal / li.quantity) : li.rate
      return { ...li, rate: newRate, total: round2(li.quantity * newRate) }
    })
  } else {
    // Nothing to scale from (e.g. an AI draft that was never priced before
    // being sent) — fall back to one synthetic, clearly-labelled line item
    // rather than leaving stale $0 items next to a nonzero total.
    rescaled = [{
      id: nanoid(),
      description: 'Negotiated total (per client counter-offer)',
      quantity: 1,
      rate: round2(newSubtotal),
      total: round2(newSubtotal),
    }]
  }

  // Proportional scaling of independently-rounded lines can drift a cent
  // or two from the target subtotal — force the last line to absorb it so
  // the sum always matches exactly.
  const roundedSubtotal = round2(newSubtotal)
  const currentSum = round2(rescaled.reduce((s, li) => s + li.total, 0))
  const drift = round2(roundedSubtotal - currentSum)
  if (drift !== 0 && rescaled.length > 0) {
    const last = rescaled[rescaled.length - 1]
    last.total = round2(last.total + drift)
    last.rate = last.quantity !== 0 ? round2(last.total / last.quantity) : last.rate
  }

  return { lineItems: rescaled, subtotal: roundedSubtotal, total: round2(newTotal) }
}
