// lib/sow/date-conflicts.ts
//
// A SOW states the same Client dependency in two places: a Client-owned row of the Deliverables table (with a target date) and a
// sentence of Assumptions & Dependencies. The model sometimes merges two items with different dates into one row ("Account access
// and raw UGC footage - November 1") while Assumptions give the second item its own date (November 8). Both can be read as "the"
// deadline. This finds those: a Client-owned dated row, and an Assumptions sentence about the same thing with a different date.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_ALT = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const DATE_MDY = new RegExp(`\\b${MONTH_ALT}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi')
const DATE_DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_ALT}\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi')

const STOP = new Set(['client', 'clients', 'provider', 'will', 'with', 'from', 'that', 'this', 'each', 'every', 'their', 'there', 'shall', 'which', 'when', 'where', 'after', 'before', 'within', 'sufficient', 'volume', 'granted', 'given', 'provided', 'provide', 'supplied', 'supply', 'deliver', 'delivered', 'ongoing', 'weekly', 'monthly', 'posts', 'basis', 'thereafter', 'frequency', 'support', 'including', 'least'])

const monthIndex = (m: string) => MONTHS.findIndex(x => x.startsWith(m.toLowerCase().slice(0, 3)))
const strip = (html: string) => String(html ?? '').replace(/<\/(?:p|li|div|tr)>/gi, '.\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ')

/** "m-d" keys (year ignored unless both sides give one, which is rare in these documents). */
export function datesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(DATE_MDY)) { const mi = monthIndex(m[1]); if (mi >= 0) out.push(`${mi + 1}-${Number(m[2])}`) }
  for (const m of text.matchAll(DATE_DMY)) { const mi = monthIndex(m[2]); if (mi >= 0) out.push(`${mi + 1}-${Number(m[1])}`) }
  return out
}

const MONTH_NAMES_TITLE = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function isoToWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso))
  return m ? `${MONTH_NAMES_TITLE[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(iso)
}

function keywords(text: string): Set<string> {
  const words = String(text ?? '').toLowerCase().match(/[a-z]{5,}/g) ?? []
  return new Set(words.filter(w => !STOP.has(w) && !MONTHS.includes(w)))
}

/** One message per (Client row, conflicting Assumptions sentence). Empty when the SOW agrees with itself. */
export function findClientDateConflicts(
  deliverableRows: Array<Record<string, string>> | null | undefined,
  assumptionsHtml: string | null | undefined,
  /** ISO dates the platform set for the Client (access, initial materials). A Client row dated anything else is reported. */
  allowedIso?: string[] | null,
): string[] {
  const rows = Array.isArray(deliverableRows) ? deliverableRows : []
  const sentences = strip(String(assumptionsHtml ?? '')).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)
  const messages: string[] = []
  for (const row of rows) {
    if (!/client/i.test(String(row?.owner ?? ''))) continue
    const rowDates = datesIn(String(row?.targetDate ?? ''))
    if (rowDates.length !== 1) continue
    if (allowedIso && allowedIso.length) {
      const allowed = new Set(allowedIso.flatMap(iso => datesIn(isoToWords(iso))))
      if (!allowed.has(rowDates[0])) {
        const title = String(row.deliverable ?? '').replace(/\s+/g, ' ').trim()
        messages.push(`The Deliverables table gives "${title}" the Client date ${String(row.targetDate).trim()}, but the platform set the Client's dates at ${allowedIso.map(isoToWords).join(' and ')}. Use exactly those dates for what the Client supplies.`)
      }
    }
    const kw = keywords(`${row?.deliverable ?? ''} ${row?.acceptanceCriteria ?? ''}`)
    for (const sent of sentences) {
      const sd = datesIn(sent)
      if (!sd.length || sd.includes(rowDates[0])) continue
      if (![...keywords(sent)].some(w => kw.has(w))) continue
      const title = String(row.deliverable ?? '').replace(/\s+/g, ' ').trim()
      messages.push(`The Deliverables table gives "${title}" one Client date (${String(row.targetDate).trim()}), but Assumptions give a different date for related work: "${sent.replace(/\.$/, '')}". Give each client-supplied item its own row and one date, the same in both places.`)
    }
  }
  return Array.from(new Set(messages))
}

// ── Recurring work: one start date ───────────────────────────────────────────────────────────────────────────────────────────────
// A recurring Provider deliverable states when it starts in the Deliverables table ("Weekly from November 13, 2026"), and the
// Timeline's ongoing phase can restate it ("From December 1, 2026 the Provider posts weekly"). Read together those say weekly
// posting starts on two different dates. A sentence that says the work CONTINUES is not a restatement and is left alone.

const CADENCES: Array<{ name: string; row: RegExp; sentence: RegExp }> = [
  { name: 'weekly', row: /\bweekly\b|\bper week\b|\beach week\b/i, sentence: /\bweekly\b|\bper week\b|\beach week\b|\bevery week\b/i },
  { name: 'monthly', row: /\bmonthly\b|\bper month\b|\beach month\b/i, sentence: /\bmonthly\b|\bper month\b|\beach month\b|\bevery month\b/i },
]
const CONTINUES = /\bcontinu(?:e|es|ed|ing)\b|\bremain(?:s|ing)?\b|\bkeeps?\b|\bresum(?:e|es|ing)\b/i

/** One message per (recurring Provider row, Timeline sentence that restarts the same cadence on a different date). */
export function findRecurringStartConflicts(
  deliverableRows: Array<Record<string, string>> | null | undefined,
  timelineRows: Array<Record<string, string>> | null | undefined,
): string[] {
  const rows = Array.isArray(deliverableRows) ? deliverableRows : []
  const phases = Array.isArray(timelineRows) ? timelineRows : []
  const messages: string[] = []
  for (const row of rows) {
    if (/client/i.test(String(row?.owner ?? ''))) continue
    const target = String(row?.targetDate ?? '')
    const fromMatch = /\bfrom\b([^]*)$/i.exec(target)
    if (!fromMatch) continue
    const rowDates = datesIn(fromMatch[1])
    if (rowDates.length !== 1) continue
    const cadence = CADENCES.find(c => c.row.test(target))
    if (!cadence) continue
    for (const ph of phases) {
      const sentences = strip(String(ph?.description ?? '')).split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean)
      for (const sent of sentences) {
        if (!cadence.sentence.test(sent) || CONTINUES.test(sent)) continue
        const fromSent = /\bfrom\b([^]*)$/i.exec(sent)
        if (!fromSent) continue
        const sd = datesIn(fromSent[1])
        if (sd.length !== 1 || sd[0] === rowDates[0]) continue
        const title = String(row.deliverable ?? '').replace(/\s+/g, ' ').trim()
        messages.push(`The Deliverables table starts \"${title}\" ${target.trim().replace(/^\w/, c => c.toLowerCase())}, but the Timeline says \"${sent.replace(/\.$/, '')}\". Say that the ${cadence.name} work continues from the date the Deliverables table gives, or give both the same start date.`)
      }
    }
  }
  return Array.from(new Set(messages))
}
