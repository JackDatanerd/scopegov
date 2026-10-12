// lib/documents/retainer-period.ts
//
// Which calendar month a retainer's FIRST monthly fee pays for. Billing used to be anchored on the month the SOW was SIGNED, so a
// retainer signed on Oct 12 to start on Nov 1 got an October-dated "Monthly retainer" row at signing AND a November row from the
// monthly job: the client was billed twice for the first month, and the first invoice carried no indication of what period it covered.
// The first service month is the later of the signing month and the month the engagement starts.

export interface RetainerMonth { year: number; month0: number }

export function firstRetainerMonth(signedAt: Date, startDate: string | null | undefined): RetainerMonth {
  const signed: RetainerMonth = { year: signedAt.getUTCFullYear(), month0: signedAt.getUTCMonth() }
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(String(startDate ?? ''))
  if (!m) return signed
  const start: RetainerMonth = { year: Number(m[1]), month0: Number(m[2]) - 1 }
  if (!(start.month0 >= 0 && start.month0 <= 11)) return signed
  return (start.year * 12 + start.month0) > (signed.year * 12 + signed.month0) ? start : signed
}

export function retainerMonthLabel(m: RetainerMonth): string {
  return new Date(Date.UTC(m.year, m.month0, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function retainerMonthKey(m: RetainerMonth): string {
  return `${m.year}-${String(m.month0 + 1).padStart(2, '0')}`
}
