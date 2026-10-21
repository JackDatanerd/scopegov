// lib/documents/conformed-sow.ts
//
// The "amended copy" of a signed SOW.
//
// A signed SOW is immutable: it is frozen at signing and every later change is a signed change order. That leaves a reader of the
// SOW alone looking at the ORIGINAL contract value, the ORIGINAL delivery date and an Out of Scope list that still names work the
// client has since bought. This module derives a separate, read-only reference view from the signed SOW plus its accepted change
// orders. Nothing here is stored over, or written back to, the signed document: the signed SOW and every signed change order remain
// the binding documents, and the amended copy says so on its face.

export interface ConformedCo {
  /** Document number, e.g. "CO-0013". */
  number: string | null
  title: string
  acceptedAt: string | null
  /** Net (pre-tax) change to the contract value. Negative for a credit. */
  netImpact: number
  timelineDays: number | null
  /** ISO date (YYYY-MM-DD) or null. */
  revisedDeliveryDate: string | null
  /** The change order's own Impact Analysis text: it names the exclusion it amends. */
  scopeNote: string | null
  addedDeliverables: string[]
  removedDeliverables: string[]
  isRenewal: boolean
}

export interface DeliverableRow { deliverable?: string; acceptanceCriteria?: string; owner?: string; targetDate?: string; [k: string]: unknown }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const stripTags = (h: string) => h.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const ref = (co: ConformedCo) => co.number || 'a change order'

/** "2027-01-07" → "January 7, 2027" (UTC, so the day never shifts). Anything unparseable is returned as given. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** The latest revised delivery date any accepted change order states (ISO), or null. */
export function latestRevisedDate(cos: ConformedCo[]): string | null {
  const dates = cos.map(c => c.revisedDeliveryDate).filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}/.test(d)).map(d => d.slice(0, 10))
  return dates.length ? dates.sort().at(-1)! : null
}

/** Original value plus every change order's net impact. A retainer renewal replaces the rate, so it never adds to a total. */
export function revisedContractValue(original: number, cos: ConformedCo[]): number {
  const sum = cos.filter(c => !c.isRenewal).reduce((n, c) => n + (Number.isFinite(c.netImpact) ? c.netImpact : 0), 0)
  return Math.round((original + sum + Number.EPSILON) * 100) / 100
}

/**
 * The signed Deliverables table, unchanged, with one added row per deliverable a change order added (marked with the change order that
 * added it) and a note on any row a credit change order removed. Returns new rows; the input is never mutated.
 */
export function conformedDeliverableRows(rows: DeliverableRow[], cos: ConformedCo[]): DeliverableRow[] {
  const out: DeliverableRow[] = (rows || []).map(r => ({ ...r }))
  for (const co of cos) {
    for (const removed of co.removedDeliverables) {
      const hit = out.find(r => norm(String(r.deliverable || '')) === norm(removed))
      if (hit) hit.deliverable = `${hit.deliverable} (removed by ${ref(co)})`
    }
  }
  for (const co of cos) {
    for (const added of co.addedDeliverables) {
      const title = String(added || '').trim()
      if (!title) continue
      if (out.some(r => norm(String(r.deliverable || '')) === norm(title))) continue
      out.push({
        deliverable: title,
        acceptanceCriteria: `Added by ${ref(co)}. Scope, limits and exclusions are as stated in that change order.`,
        owner: 'Provider',
        targetDate: co.revisedDeliveryDate ? longDate(co.revisedDeliveryDate) : '',
      })
    }
  }
  return out
}

/**
 * Mark each Out of Scope item that a change order brought into scope. A change order names the exclusion it amends by its printed
 * title in its Impact Analysis (for example the "Professional headshots" exclusion), so an item whose title (the words before its
 * first colon) appears in a change order's impact text or added deliverables is annotated. Every other exclusion is left exactly as
 * signed, and the annotation says the exclusion otherwise stays in place.
 */
export function annotateBroughtIntoScope(oosHtml: string, cos: ConformedCo[]): string {
  if (!oosHtml) return oosHtml
  const candidates = cos.filter(c => !c.isRenewal && (c.scopeNote || c.addedDeliverables.length))
  if (!candidates.length) return oosHtml
  return oosHtml.replace(/<(li|p)>([\s\S]*?)<\/\1>/gi, (whole, tag: string, inner: string) => {
    const text = stripTags(inner)
    const title = norm(text.split(':')[0] || '')
    if (title.length < 4 || title.length > 80) return whole
    const co = candidates.find(c => norm([c.scopeNote || '', ...c.addedDeliverables].join(' ')).includes(title))
    if (!co) return whole
    return `<${tag}>${inner} <em>Amended by ${escapeHtml(ref(co))}: brought into scope for the work that change order describes. This exclusion otherwise stays in place.</em></${tag}>`
  })
}

/** Plain-English one-liner for the amendment table's timeline column. */
export function timelineText(co: ConformedCo): string {
  const parts: string[] = []
  if (co.timelineDays) parts.push(`${co.timelineDays > 0 ? '+' : ''}${co.timelineDays} days`)
  if (co.revisedDeliveryDate) parts.push(`delivery ${longDate(co.revisedDeliveryDate)}`)
  return parts.join(', ') || 'No change'
}
