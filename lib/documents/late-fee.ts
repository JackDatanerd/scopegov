// lib/documents/late-fee.ts
//
// The one place that decides what a late-fee rate is and how every document words it, so the SOW, change order and invoice
// can never state it differently.

/** A usable rate: a finite number above 0 and at most 100, rounded to 2 decimals. Anything else means "no late fee". */
export function normalizeLateFeeRate(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null
  return Math.round(n * 100) / 100
}

/** "1.5" not "1.50", "2" not "2.00". */
export function formatLateFeeRate(rate: number): string {
  return String(Math.round(rate * 100) / 100)
}

/** The contract wording (Payment Terms of the SOW). */
export function lateFeeContractSentence(rate: number): string {
  return `Amounts not paid by their due date accrue a late fee of ${formatLateFeeRate(rate)}% per month until paid, or the maximum rate permitted by applicable law if lower.`
}

/** The reminder printed on change orders and invoices, which point back to the SOW that sets the term. */
export function lateFeeReminder(rate: number, sowNumber?: string | null): string {
  return `Overdue amounts accrue a late fee of ${formatLateFeeRate(rate)}% per month${sowNumber ? `, as set out in SOW No. ${sowNumber}` : ''}.`
}
