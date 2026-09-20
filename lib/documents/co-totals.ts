// lib/documents/co-totals.ts
//
// FIX (section-10 audit, 10-B3 + 10-B9): POST /api/co and PATCH
// /api/co/[id] each computed the money independently, off completely
// unvalidated request JSON:
//
//   const subtotal = items.reduce((s, l) => s + (l.quantity * l.rate), 0)
//
// No type coercion, no NaN guard, no non-negative check, no cap on item
// count or description length. The client-side `min` attributes are
// browser hints only, and CoEditor's `parseFloat(v) || 0` lets a typed
// negative straight through.
//
// And the tax-inclusive branch was wrong in a way the client could see:
// when taxInclusive was set, `subtotal` was stored as the GROSS sum of
// the line items and `total` was set equal to it. The PDF then printed
// "Subtotal 10,000 / Tax included (16%) / Total 10,000" — a document that
// also prints the client's VAT number and never states the VAT amount
// anywhere. lib/utils/rescale-line-items.ts already back-solves this
// correctly (`newTotal / (1 + rate/100)`), so the right shape existed in
// the codebase; the write path just never used it.
//
// One shared, validated implementation both routes call.

import { roundCurrency } from '@/lib/utils/format'

export interface CoLineItem {
  id?: string
  description: string
  quantity: number
  rate: number
  total: number
  /** System-written negotiation line — may be negative; see rescale-line-items.ts. */
  kind?: 'adjustment'
}

export interface CoTotals {
  lineItems: CoLineItem[]
  /** Net of tax, always — this is what the PDF's "Subtotal" row means. */
  subtotal: number
  taxRate: number
  taxInclusive: boolean
  /** Gross. */
  total: number
}

export type CoTotalsResult =
  | { ok: true; totals: CoTotals }
  | { ok: false; error: string }

const MAX_LINE_ITEMS       = 50
const MAX_DESCRIPTION_LEN  = 500
const MAX_QUANTITY         = 1_000_000
const MAX_RATE             = 1_000_000_000

export function computeCoTotals(
  rawItems: unknown, rawTaxRate: unknown, rawTaxInclusive: unknown
): CoTotalsResult {
  if (!Array.isArray(rawItems)) return { ok: false, error: 'Line items must be a list' }
  if (rawItems.length > MAX_LINE_ITEMS)
    return { ok: false, error: `A change order can have at most ${MAX_LINE_ITEMS} line items` }

  const taxRate = Number(rawTaxRate)
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)
    return { ok: false, error: 'Tax rate must be between 0 and 100' }

  const taxInclusive = rawTaxInclusive === true

  const lineItems: CoLineItem[] = []
  for (const raw of rawItems as any[]) {
    const description = typeof raw?.description === 'string' ? raw.description.trim() : ''
    if (description.length > MAX_DESCRIPTION_LEN)
      return { ok: false, error: `Line item descriptions must be under ${MAX_DESCRIPTION_LEN} characters` }

    // A counter-offer that lands below the original price is reconciled by a system-written
    // negative "Negotiated discount" line (rescale-line-items.ts). It must round-trip through
    // here — otherwise a revision cloned from such a CO could never be saved again.
    const isAdjustment = raw?.kind === 'adjustment'
    const quantity = isAdjustment ? 1 : Number(raw?.quantity)
    const rate     = Number(raw?.rate)

    if (!Number.isFinite(quantity) || !Number.isFinite(rate))
      return { ok: false, error: `Line item "${description || 'untitled'}" has a quantity or rate that isn't a number` }
    // Negatives are refused rather than clamped: a negative line would
    // quietly reduce the contract value through a document the client
    // reads as an addition, and the Impact Analysis block prints the CO
    // total with a hardcoded "+" (10-B4). A reduction belongs in its own
    // explicitly-worded change order, not a negative line hidden in one.
    if (!isAdjustment && (quantity < 0 || rate < 0))
      return { ok: false, error: `Line item "${description || 'untitled'}" can't have a negative quantity or rate` }
    if (quantity > MAX_QUANTITY || Math.abs(rate) > MAX_RATE)
      return { ok: false, error: `Line item "${description || 'untitled'}" has an implausibly large quantity or rate` }

    // Round the inputs FIRST and derive the total from the rounded values, so the row the
    // client reads (qty × rate) always equals the total printed beside it. (Rounding qty to
    // 2dp but multiplying the unrounded qty showed 1.33 × 90 = 119.97.)
    const q = roundCurrency(quantity)
    const r = roundCurrency(rate)
    lineItems.push({
      ...(typeof raw?.id === 'string' ? { id: raw.id } : {}),
      description,
      quantity: q,
      rate:     r,
      total:    roundCurrency(q * r),
      ...(isAdjustment ? { kind: 'adjustment' as const } : {}),
    })
  }

  const lineSum = roundCurrency(lineItems.reduce((s, l) => s + l.total, 0))

  // Line-item amounts are what the agency typed. When tax is inclusive
  // those figures already contain the tax, so the gross IS the line sum
  // and the net has to be back-solved out of it — that net is what the
  // document's "Subtotal" row states, and total − subtotal is the tax
  // amount the PDF can finally print.
  const subtotal = taxInclusive && taxRate > 0
    ? roundCurrency(lineSum / (1 + taxRate / 100))
    : lineSum
  const total = taxInclusive
    ? lineSum
    : roundCurrency(lineSum * (1 + taxRate / 100))

  return { ok: true, totals: { lineItems, subtotal, taxRate, taxInclusive, total } }
}
