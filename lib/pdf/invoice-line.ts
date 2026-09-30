/**
 * Amount printed on the single (non-itemized) line of an invoice PDF.
 *
 * FIX (section-12 independent pass): the line used to print the GROSS invoice total
 * unconditionally. For a tax-EXCLUSIVE invoice ("Before tax" pricing, e.g. 1,000 @ 16%)
 * the totals block beneath it prints Subtotal 1,000.00 / Tax 160.00 / Amount due 1,160.00,
 * so the line row read 1,160.00 above a Subtotal of 1,000.00 — a client adding the line
 * to the tax row got 1,320.00 against an Amount due of 1,160.00.
 *
 * - tax-exclusive with tax  -> the line carries the NET (subtotal), so line + tax = amount due
 * - tax-inclusive           -> the line carries the GROSS; the "Tax included" row follows
 * - no tax                  -> amount (subtotal === amount)
 */
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export function invoiceSingleLineAmount(input: {
  amount: number
  subtotal?: number | null
  taxRate?: number | null
  taxInclusive?: boolean | null
}): number {
  const amount = r2(input.amount)
  const hasTax = (Number(input.taxRate) || 0) > 0
  if (!hasTax || input.taxInclusive) return amount
  return r2(input.subtotal ?? input.amount)
}
