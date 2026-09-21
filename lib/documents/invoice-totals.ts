// lib/documents/invoice-totals.ts
//
// FIX (section-12 audit, pass 2): POST /api/invoices and PATCH /api/invoices/[id]
// each computed the money on their own from raw request JSON, and neither did
// what the change-order side (lib/documents/co-totals.ts) has done since its own
// audit:
//
//   * Nothing was ROUNDED. A tax-exclusive invoice stored `net × (1 + rate)` as
//     an unconstrained numeric — 333.33 at 16% is 386.6628 in the database while
//     the PDF and email print "386.66". A client who pays the printed amount
//     leaves 0.0028 outstanding, the paid-status trigger compares `paid >= amount`
//     exactly, and the invoice sits 'partially_paid' forever (then goes overdue
//     and gets dunned). ~46% of non-round tax-exclusive invoices hit this in a
//     simulation. PDF rows (subtotal + tax vs total) could also disagree by a
//     cent, because each was rounded independently for display.
//   * The tax rate was unbounded (negative, NaN, 1000%), line-item count and
//     quantities were unbounded, and each line's `total` was TRUSTED from the
//     client instead of being quantity × rate.
//
// One validated, rounding implementation for both routes. Money is rounded to 2
// decimals with roundCurrency (the same helper CO totals use).

import { roundCurrency } from '@/lib/utils/format'

export interface InvoiceLineItem {
  description: string
  quantity: number
  rate: number
  total: number
}

export interface InvoiceTotals {
  /** Gross — what the client owes. Always what invoices.amount stores. */
  amount: number
  /** Net of tax, always — what the PDF's "Subtotal" row means. */
  subtotal: number
  taxRate: number
  taxInclusive: boolean
  lineItems: InvoiceLineItem[]
  isItemized: boolean
}

export type InvoiceTotalsResult =
  | { ok: true; totals: InvoiceTotals }
  | { ok: false; error: string }

export const MAX_INVOICE_LINE_ITEMS = 50
const MAX_DESCRIPTION_LEN = 500
const MAX_QUANTITY = 1_000_000
const MAX_RATE = 1_000_000_000
const MAX_AMOUNT = 1_000_000_000_000

/**
 * @param entered   The figure the agency typed: the NET when tax is exclusive, the
 *                  GROSS when tax is inclusive. Ignored (but cross-checked when
 *                  present) for an itemized invoice, whose amount is the line sum.
 * @param taxRate   undefined = inherit `inherited.taxRate` (or 0); otherwise 0–100.
 * @param taxInclusive  undefined = inherit `inherited.taxInclusive`. Forced false for
 *                  an itemized invoice — line items are a pre-tax breakdown by construction.
 */
export function computeInvoiceTotals(input: {
  entered: unknown
  taxRate: unknown
  taxInclusive: unknown
  lineItems?: unknown
  inherited?: { taxRate: number; taxInclusive: boolean } | null
}): InvoiceTotalsResult {
  // ── tax rate ────────────────────────────────────────────────
  let taxRate: number
  if (input.taxRate === undefined) {
    taxRate = input.inherited?.taxRate || 0
  } else if (input.taxRate === null || input.taxRate === '') {
    taxRate = 0
  } else {
    taxRate = Number(input.taxRate)
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)
      return { ok: false, error: 'Tax rate must be a number between 0 and 100' }
  }

  // ── line items ──────────────────────────────────────────────
  let lineItems: InvoiceLineItem[] = []
  if (input.lineItems !== undefined && input.lineItems !== null) {
    if (!Array.isArray(input.lineItems)) return { ok: false, error: 'Line items must be a list' }
    if (input.lineItems.length > MAX_INVOICE_LINE_ITEMS)
      return { ok: false, error: `An invoice can have at most ${MAX_INVOICE_LINE_ITEMS} line items` }
    for (const raw of input.lineItems) {
      const description = typeof raw?.description === 'string' ? raw.description.trim() : ''
      if (!description) continue // blank rows are dropped, same as before
      if (description.length > MAX_DESCRIPTION_LEN)
        return { ok: false, error: `Line item descriptions must be under ${MAX_DESCRIPTION_LEN} characters` }
      const quantity = Number(raw?.quantity)
      const rate = Number(raw?.rate)
      if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY)
        return { ok: false, error: `"${description.slice(0, 40)}": quantity must be between 0 and ${MAX_QUANTITY.toLocaleString('en-US')}` }
      if (!Number.isFinite(rate) || rate < 0 || rate > MAX_RATE)
        return { ok: false, error: `"${description.slice(0, 40)}": rate can't be negative or unreasonably large` }
      // The line total is ALWAYS quantity × rate — a client-supplied `total` is
      // never trusted (it used to be stored as sent).
      lineItems.push({ description, quantity, rate, total: roundCurrency(quantity * rate) })
    }
  }
  const isItemized = lineItems.length > 0

  const taxInclusive = isItemized
    ? false
    : input.taxInclusive !== undefined ? !!input.taxInclusive : !!input.inherited?.taxInclusive

  // ── the entered figure ──────────────────────────────────────
  let entered: number
  if (isItemized) {
    const lineSum = roundCurrency(lineItems.reduce((s, l) => s + l.total, 0))
    // A stale form (edited line items, then the amount field lagged behind) must
    // not silently win over the line items the client will actually see.
    if (input.entered !== undefined && input.entered !== null && input.entered !== '') {
      const typed = Number(input.entered)
      if (!Number.isFinite(typed) || Math.abs(typed - lineSum) > 0.01)
        return { ok: false, error: `Line items total ${lineSum.toFixed(2)} does not match the invoice amount ${Number.isFinite(typed) ? typed.toFixed(2) : String(input.entered)}` }
    }
    entered = lineSum
  } else {
    entered = Number(input.entered)
    if (!Number.isFinite(entered) || entered <= 0) return { ok: false, error: 'Amount must be a positive number' }
    if (entered > MAX_AMOUNT) return { ok: false, error: 'Amount is unreasonably large' }
    entered = roundCurrency(entered)
    if (entered <= 0) return { ok: false, error: 'Amount must be at least 0.01' }
  }

  // ── grossing up / backing out ───────────────────────────────
  // `amount` is always the grand total the client owes; `subtotal` always the net.
  let amount = entered
  let subtotal = entered
  if (taxRate > 0) {
    if (taxInclusive) {
      subtotal = roundCurrency(entered / (1 + taxRate / 100))
    } else {
      amount = roundCurrency(entered * (1 + taxRate / 100))
    }
  }

  return { ok: true, totals: { amount, subtotal, taxRate, taxInclusive, lineItems, isItemized } }
}

/** The figure to feed back into computeInvoiceTotals as `entered` for an EXISTING invoice. */
export function enteredAmountOf(invoice: { amount: number | string; subtotal?: number | string | null; tax_inclusive?: boolean | null; tax_rate?: number | string | null }): number {
  const gross = Number(invoice.amount)
  const net = invoice.subtotal == null ? gross : Number(invoice.subtotal)
  const taxed = Number(invoice.tax_rate || 0) > 0
  return invoice.tax_inclusive || !taxed ? gross : net
}

/** A real calendar date in YYYY-MM-DD form (an ISO timestamp's date part is accepted), else null. */
export function parseDateOnly(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim())
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}
