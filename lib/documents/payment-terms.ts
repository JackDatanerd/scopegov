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

// ── The contract text is the source of truth ──────────────────────────────────────────────────────────────────────────────────────
// The SOW freezes the workspace's payment period into metadata when it is drafted, but the agency can edit the Payment Terms text
// afterwards ("within 14 days" -> "within 30 days"). The client signs the text, so what is enforced and printed on change orders
// and invoices must be what the text says. The term is therefore re-read from the text when the SOW is sent (the text is locked
// from then on) and the frozen value is made to match.

const TERM_RE = /\b(?:due|payable)\s+(?:and\s+payable\s+)?within\s+(\d{1,3})\s+(?:calendar\s+|business\s+)?days?\s+(?:of|from|after)\s+(?:its|the|their|an?)?\s*invoice\s+date\b/i
const plainText = (html: unknown) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')

/** The payment period the SOW text states ("due within N days of its invoice date"), or null when it states none. Business days are not calendar days, so a business-day term is not read as one. */
export function paymentTermsDaysFromText(sections: Array<{ id?: string; content?: string; visible?: boolean }> | null | undefined): number | null {
  const visible = (sections || []).filter(s => s && s.visible !== false)
  // The Payment Terms section first; a sentence elsewhere (an Assumptions line) only if that one is silent.
  const ordered = [...visible.filter(s => s.id === 'payment'), ...visible.filter(s => s.id !== 'payment')]
  for (const sec of ordered) {
    const m = TERM_RE.exec(plainText(sec.content))
    if (!m) continue
    if (/business/i.test(m[0])) return null
    return wholeDays(m[1])
  }
  return null
}

/**
 * The metadata a sent SOW carries: paymentTermsDays follows the text. Returns the same object when nothing changes, so a caller
 * can skip the write. A SOW whose text no longer states a period has no period to enforce.
 */
export function reconcileSowPaymentTerms<T extends Record<string, any>>(
  metadata: T | null | undefined,
  sections: Array<{ id?: string; content?: string; visible?: boolean }> | null | undefined,
): { metadata: Record<string, any>; changed: boolean } {
  const meta: Record<string, any> = { ...(metadata || {}) }
  const fromText = paymentTermsDaysFromText(sections)
  const current = sowPaymentTermsDays(meta)
  if (fromText === current) return { metadata: meta, changed: false }
  if (fromText == null) delete meta.paymentTermsDays
  else meta.paymentTermsDays = fromText
  return { metadata: meta, changed: true }
}
