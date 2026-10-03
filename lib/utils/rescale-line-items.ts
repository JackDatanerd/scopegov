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
import { roundCurrency } from '@/lib/utils/format'

export interface RescaleLineItem {
  id: string
  description: string
  quantity: number
  rate: number
  total: number
  /**
   * 'adjustment' marks a line the system wrote to reconcile a negotiated counter-offer
   * ("Negotiated discount…"). Adjustment lines may be negative, are never a
   * deliverable, and must survive a save/revise round-trip (see co-totals.ts).
   */
  kind?: 'adjustment'
}

// The EXACT wordings rescaleLineItemsToTotal writes (and, for rows predating the `kind` flag, the only wordings that
// ever existed). Matching just the prefix (`^Negotiated (discount|increase|total)\b`) also caught ordinary,
// user-typed lines such as "Negotiated increase in support hours": a PATCH then re-labelled them as system adjustments
// (quantity forced to 1 — a 5 x 100 line silently became 100) and finalize-co dropped them from the scope deliverables.
const ADJUSTMENT_DESCRIPTION_RE = /^Negotiated (discount \(per counter-offer\)|increase \(per counter-offer\)|total \(per client counter-offer\))$/i

/** True for a system-written negotiation line (flagged, or — for rows written before the flag existed — recognised by its fixed wording). */
export function isAdjustmentLine(li: { kind?: string; description?: string; quantity?: unknown } | null | undefined): boolean {
  if (!li) return false
  if (li.kind === 'adjustment') return true
  // Wording-only (legacy) match: the system always writes quantity 1, so a line with any other quantity is the user's own.
  if (li.quantity !== undefined && li.quantity !== null && Number(li.quantity) !== 1) return false
  return ADJUSTMENT_DESCRIPTION_RE.test(String(li.description || '').trim())
}

export interface RescaleResult {
  lineItems: RescaleLineItem[]
  subtotal: number
  total: number
}

const round2 = roundCurrency

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
  // The stored `subtotal` is always NET of tax (what the PDF's "Subtotal" row means and
  // what co-totals.ts stores). For a tax-inclusive total the line items are gross, so the
  // net has to be back-solved — storing the gross here printed "Subtotal 10,000 / Tax
  // included (16%) / Total 10,000" on every counter-accepted inclusive CO.
  const netSubtotal = taxInclusive && safeTaxRate > 0
    ? round2(newTotal / (1 + safeTaxRate / 100))
    : roundedSubtotal

  // Sum what each row PRINTS (its stored, already-rounded `total`), not qty × rate re-multiplied: co-totals.ts rounds
  // every row's total to the cent, so with a fractional quantity (1.33 × 10.05 = 13.3665 -> 13.37) the re-multiplied sum
  // can sit a cent away from the rows the client reads, leaving the negotiated-adjustment line a cent off and the
  // document's rows not summing to its subtotal. Rows without a usable total fall back to qty × rate.
  const rowAmount = (li: RescaleLineItem) => Number.isFinite(Number(li.total)) && li.total !== null && (li as any).total !== undefined
    ? Number(li.total)
    : li.quantity * li.rate
  const oldSubtotal = round2(lineItems.reduce((s, li) => s + rowAmount(li), 0))

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
        kind: 'adjustment',
      }],
      subtotal: netSubtotal,
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
      kind: 'adjustment',
    })
  }

  return { lineItems: lineItemsOut, subtotal: netSubtotal, total: round2(newTotal) }
}
