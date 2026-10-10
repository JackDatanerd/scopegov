// lib/sow/brief-signals.ts
//
// What the brief parser reads BESIDE the scope text: how the client expects to be billed, what term (if any) they
// named, and how revisions are counted. These decide things the person filling in the form often cannot see are
// connected — a brief that says "$1,200 a month, paid monthly upfront" describes a retainer, but the project is
// only billed as one if its type is Retainer. Before this file the parser's answer ('monthly') was quietly turned
// into a 50/50 split for any non-retainer project, so the SOW said "ongoing monthly engagement" and "two instalments".
//
// Pure functions only (no I/O) so the rules are unit-testable and shared by the parse route and both forms.

export type BillingCadence = 'monthly' | 'one_off' | ''

export interface BriefBillingSignals {
  billingCadence: BillingCadence
  /** The recurring/one-off fee the brief states, in the project's currency. Null when none was stated. */
  feeAmount: number | null
  /** A fixed term in months the brief names (e.g. "6-month retainer"). Null = none stated (open-ended). */
  termMonths: number | null
  /** How the brief counts revisions when it is not simply "N rounds" (e.g. "1 caption revision per post"). */
  revisionNote: string
}

export const MAX_REVISION_NOTE = 200

export function normalizeBillingCadence(v: unknown): BillingCadence {
  if (typeof v !== 'string') return ''
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (s === 'monthly' || s === 'month' || s === 'recurring_monthly') return 'monthly'
  if (s === 'one_off' || s === 'oneoff' || s === 'fixed' || s === 'one_time') return 'one_off'
  return ''
}

export function normalizeFeeAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : NaN
  return Number.isFinite(n) && n > 0 && n < 1e12 ? Math.round(n * 100) / 100 : null
}

/** 1-60 whole months (the same bound parseRetainerMonths enforces on the project); anything else = not stated. */
export function normalizeTermMonths(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : null
}

export function normalizeRevisionNote(v: unknown): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > MAX_REVISION_NOTE ? t.slice(0, MAX_REVISION_NOTE).trim() : t
}

export function normalizeBillingSignals(raw: Record<string, unknown> | null | undefined): BriefBillingSignals {
  const r = raw || {}
  return {
    billingCadence: normalizeBillingCadence(r.billingCadence),
    feeAmount: normalizeFeeAmount(r.feeAmount),
    termMonths: normalizeTermMonths(r.termMonths),
    revisionNote: normalizeRevisionNote(r.revisionNote),
  }
}

export interface RetainerSuggestion {
  /** Term to apply when the person accepts: null = open-ended, matching a brief that names no end. */
  termMonths: number | null
  feeAmount: number | null
}

/**
 * When the brief describes monthly billing but the project is not a retainer, the person should be offered the switch
 * instead of having 'monthly' silently replaced by 50/50. Null = nothing to suggest.
 */
export function retainerSuggestion(
  signals: Pick<BriefBillingSignals, 'billingCadence' | 'feeAmount' | 'termMonths'> | null | undefined,
  projectType: string | null | undefined,
): RetainerSuggestion | null {
  if (!signals || signals.billingCadence !== 'monthly') return null
  if (projectType === 'retainer') return null
  return { termMonths: signals.termMonths, feeAmount: signals.feeAmount }
}

/** True when a project-type change moves the project into or out of retainer billing. */
export function isBillingModelChange(from: string | null | undefined, to: string | null | undefined): boolean {
  if (!from || !to || from === to) return false
  return from === 'retainer' || to === 'retainer'
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}

function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * A start date the brief states, as an ISO date. A date written WITHOUT a year ("Start date: November 1") means the next
 * such day on or after `today` — never a year the model guessed from its own training data (a signed SOW once printed
 * "November 1, 2025" a year before it was signed). Anything unreadable is null, and the form simply asks.
 */
export function resolveBriefStartDate(raw: unknown, today: Date = new Date()): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(/\s+/g, ' ')
  if (!s || s.length > 60) return null
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (iso) return isoDate(+iso[1], +iso[2], +iso[3])
  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1, td = today.getUTCDate()
  // "November 1", "Nov 1st", "1 November", optionally followed by a year ("November 1, 2026" / "1 Nov 2026")
  const mdy = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(s)
  const dmy = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.?(?:,? (\d{4}))?$/.exec(s)
  const parts = mdy ? { mon: mdy[1], day: +mdy[2], year: mdy[3] } : dmy ? { mon: dmy[2], day: +dmy[1], year: dmy[3] } : null
  if (!parts) return null
  const month = MONTHS[parts.mon.toLowerCase()]
  if (!month) return null
  if (parts.year) return isoDate(+parts.year, month, parts.day)
  const thisYear = isoDate(ty, month, parts.day)
  if (!thisYear) return null
  const onOrAfterToday = month > tm || (month === tm && parts.day >= td)
  return onOrAfterToday ? thisYear : isoDate(ty + 1, month, parts.day)
}
