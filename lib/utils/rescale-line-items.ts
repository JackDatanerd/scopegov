// lib/utils/rescale-line-items.ts
//
// FIX (doc-completeness audit, finding #5): when a client counter-offers
// on a change order and the agency accepts, the CO's `total` was being
// overwritten to the negotiated amount while `subtotal` and `line_items`
// stayed at their pre-negotiation values. The rendered PDF/portal then
// showed line items and a subtotal that didn't sum to the stated total,
// and tax computed off the stale subtotal — a visibly broken legal
// document.
//
// FIX (accounting correctness, follow-up): the original fix for that
// closed the reconciliation gap by proportionally scaling every existing
// line item's rate (quantity held fixed) to hit the new total. That's
// wrong for a different reason: it silently rewrites the rate on every
// line, including T&M lines where quantity is hours actually worked at
// an agreed rate. A $150/hr line quietly becoming a $115/hr line
// misrepresents what was actually charged, and gives the client-facing
// document no visible record that a negotiation happened at all —
// counter_amount/counter_note live on the row, not on the PDF.
//
// Now: leave every existing line item exactly as agreed (rate, quantity,
// total untouched), and add ONE explicit adjustment line for the
// difference — "Negotiated discount" (negative) or "Negotiated increase"
// (positive) — so the document reconciles to the new total while still
// showing the true original pricing on every other line.

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
 * Reconciles lineItems to the subtotal implied by newTotal (back-solving
 * out tax when not tax-inclusive) by appending a single explicit
 * "Negotiated discount/increase" line for the difference, rather than
 * altering any existing line's rate. Returns the new line items plus the
 * subtotal/total to store alongside them.
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
  const roundedSubtotal = round2(newSubtotal)

  const oldSubtotal = round2(lineItems.reduce((s, li) => s + (li.quantity * li.rate), 0))

  // Nothing priced yet (e.g. an AI draft that was never priced before
  // being sent) — one clearly-labelled line rather than a $0 item next to
  // a nonzero total plus a same-amount "adjustment" line, which would
  // just be a confusing way of saying the same thing twice.
  if (oldSubtotal <= 0) {
    return {
      lineItems: [{
        id: nanoid(),
        description: 'Negotiated total (per client counter-offer)',
        quantity: 1,
        rate: roundedSubtotal,
        total: roundedSubtotal,
      }],
      subtotal: roundedSubtotal,
      total: round2(newTotal),
    }
  }

  const drift = round2(roundedSubtotal - oldSubtotal)
  const lineItemsOut = lineItems.map(li => ({ ...li })) // preserve every original line's rate/quantity/total as-is

  if (drift !== 0) {
    lineItemsOut.push({
      id: nanoid(),
      description: drift < 0 ? 'Negotiated discount (per counter-offer)' : 'Negotiated increase (per counter-offer)',
      quantity: 1,
      rate: drift,
      total: drift,
    })
  }

  return { lineItems: lineItemsOut, subtotal: roundedSubtotal, total: round2(newTotal) }
}
