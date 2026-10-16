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

/** Above this monthly rate the yearly equivalent passes 18%, which is where many jurisdictions start to cap late charges. */
export const LATE_FEE_REVIEW_MONTHLY_PERCENT = 1.5

/** The simple yearly equivalent of a monthly late fee (12 x the monthly rate), rounded to 2 decimals. */
export function lateFeeYearlyPercent(rate: number): number {
  return Math.round(rate * 12 * 100) / 100
}

/**
 * A soft warning (never a block) for a late fee high enough that it may exceed what the agency's jurisdiction allows. Null when
 * there is no late fee or it is at or below 1.5% a month. Not legal advice: the contract sentence already limits the fee to the
 * legal maximum, so this only tells the agency to check.
 */
export function lateFeeRateWarning(value: unknown): string | null {
  const rate = normalizeLateFeeRate(value)
  if (rate === null || rate <= LATE_FEE_REVIEW_MONTHLY_PERCENT) return null
  return `A late fee of ${formatLateFeeRate(rate)}% per month is about ${formatLateFeeRate(lateFeeYearlyPercent(rate))}% a year. Many jurisdictions cap late charges and interest around 18% to 24% a year, so check what applies to you. The SOW wording already limits the fee to the maximum the law permits.`
}
