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

function keywords(text: string): Set<string> {
  const words = String(text ?? '').toLowerCase().match(/[a-z]{5,}/g) ?? []
  return new Set(words.filter(w => !STOP.has(w) && !MONTHS.includes(w)))
}

/** One message per (Client row, conflicting Assumptions sentence). Empty when the SOW agrees with itself. */
export function findClientDateConflicts(deliverableRows: Array<Record<string, string>> | null | undefined, assumptionsHtml: string | null | undefined): string[] {
  const rows = Array.isArray(deliverableRows) ? deliverableRows : []
  const sentences = strip(String(assumptionsHtml ?? '')).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)
  const messages: string[] = []
  for (const row of rows) {
    if (!/client/i.test(String(row?.owner ?? ''))) continue
    const rowDates = datesIn(String(row?.targetDate ?? ''))
    if (rowDates.length !== 1) continue
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
