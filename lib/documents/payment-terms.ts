// lib/documents/payment-terms.ts
//
// One definition of "when is an invoice due under this SOW". The SOW states the payment period once ("each invoice is due
// within N days of its invoice date") and freezes N in its metadata when it is drafted, exactly like the late fee. Change
// orders and invoices under that SOW must print and obey the SOW's N, not whatever the workspace default has become since.

import { dateStringInZone, addDaysToDateString } from '@/lib/utils/timezone'

function wholeDays(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null
}

/** The payment period a SOW froze at drafting, or null for a SOW drafted before it was frozen / with no standard term. */
export function sowPaymentTermsDays(metadata: any): number | null {
  return wholeDays(metadata?.paymentTermsDays)
}

/** The period a document prints: the SOW's own when it states one, else the workspace's current standard term. */
export function effectivePaymentTermsDays(metadata: any, workspaceDefault: unknown): number | null {
  return sowPaymentTermsDays(metadata) ?? wholeDays(workspaceDefault)
}

/** The last due date the SOW's payment period allows for an invoice issued at `issuedAt`, as a YYYY-MM-DD in the workspace's zone. */
export function latestDueDate(issuedAt: Date, termDays: number, timeZone: string | null | undefined): string {
  return addDaysToDateString(dateStringInZone(timeZone, issuedAt), termDays)
}

/**
 * null when the due date honours the SOW's payment period; otherwise the sentence that says how. Only a due date LATER than the
 * period allows is a conflict (an earlier one is still "within N days"). Both dates are calendar dates in the workspace's zone —
 * the zone the invoice prints its issue date in — so a browser in another zone can no longer shift the term by a day.
 */
export function dueDateExceedsTerm(
  dueDate: string | null | undefined, issuedAt: Date, termDays: number | null, timeZone: string | null | undefined,
): { due: string; latest: string; issued: string } | null {
  if (!termDays || !dueDate || !/^\d{4}-\d{2}-\d{2}/.test(dueDate)) return null
  const due = dueDate.slice(0, 10)
  const latest = latestDueDate(issuedAt, termDays, timeZone)
  if (due <= latest) return null
  return { due, latest, issued: dateStringInZone(timeZone, issuedAt) }
}
