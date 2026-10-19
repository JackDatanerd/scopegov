// lib/documents/advance-due.ts
//
// A monthly retainer is billed IN ADVANCE: the SOW says each invoice is issued before the month of service it covers begins. The
// payment period ("due within N days of the invoice date") only says how long the client has, so counting N days from the issue date
// could put the due date AFTER the service month had already started (an invoice issued Oct 19 under a 14-day term fell due Nov 2
// for a month that began Nov 1). The default due date for an invoice that pays for a service month that has not started yet is
// therefore capped at that month's first day. It never moves a due date earlier than today, never LENGTHENS the SOW's period (it
// can only shorten it, which "within N days" allows), and the person can still edit it.

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * @param due          the due date counted from the issue date (YYYY-MM-DD), or '' when none is known
 * @param periodStart  the first day of the service month the invoice pays for (YYYY-MM-DD), or null for any other invoice
 * @param today        today's calendar date in the workspace's zone (YYYY-MM-DD)
 */
export function capDueAtPeriodStart(due: string, periodStart: string | null | undefined, today: string): string {
  if (!DATE.test(due) || !periodStart || !DATE.test(periodStart) || !DATE.test(today)) return due
  // A service month already under way is not "in advance": nothing to cap.
  if (periodStart <= today) return due
  return due > periodStart ? periodStart : due
}
