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
import { roundCurrency } from '@/lib/utils/format'

const r2 = (n: number) => roundCurrency(Number(n) || 0)

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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_YEAR = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\s+(\\d{4})\\s*$`, 'i')
const plainKey = (v: string) => v.toLowerCase().replace(/\bpayment\b/g, '').replace(/[^a-z0-9]+/g, '')

/**
 * The grey line under an invoice's single billed line (the milestone's billing trigger).
 *
 * A retainer month's trigger ("Monthly retainer payment - November 2026") only repeated its title ("Monthly retainer -
 * November 2026") and never said what the fee covers. For a retainer month it now states the service period; any other
 * trigger that merely repeats the title is dropped; every other trigger prints as written.
 */
export function invoiceLineSubtext(title: string | null | undefined, trigger: string | null | undefined): string | null {
  const trig = String(trigger || '').trim()
  if (!trig) return null
  const ttl = String(title || '').trim()
  if (/^monthly retainer\b/i.test(trig)) {
    const m = MONTH_YEAR.exec(trig) || MONTH_YEAR.exec(ttl)
    if (m) {
      const month = MONTH_NAMES.findIndex(n => n.toLowerCase() === m[1].toLowerCase())
      const year = Number(m[2])
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
      return `Service period: ${MONTH_NAMES[month]} 1 \u2013 ${last}, ${year}`
    }
  }
  if (ttl && plainKey(ttl) === plainKey(trig)) return null
  return trig
}
