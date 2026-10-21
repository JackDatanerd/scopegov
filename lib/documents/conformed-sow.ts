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

const AMENDS_RE = /\b(falls? under|amends?|amending|brings?|brought|into scope|lifts?)\b/i
// A sentence that says what is NOT covered or what stays excluded must never mark an exclusion as lifted.
const KEEPS_RE = /\b(does not|do not|not include|not included|excluded|remains?|stays? in place|other than|except)\b/i
const QUOTED_RE = /["\u201c]([^"\u201d]{3,80})["\u201d]/g

/**
 * The exclusion titles a change order says it amends: a title counts only when it is QUOTED in a sentence of the change order's own
 * Impact Analysis that says the work falls under / amends / brings that exclusion into scope. A sentence that says what is not
 * covered ("does not include listing photography") or what stays in place can never name one.
 */
export function amendedExclusionTitles(scopeNote: string | null | undefined): string[] {
  const titles: string[] = []
  for (const sentence of String(scopeNote || '').split(/(?<=[.!?])\s+/)) {
    if (!AMENDS_RE.test(sentence) || KEEPS_RE.test(sentence)) continue
    // The change order also quotes the section it is amending ("Out of Scope"); that is a heading, not an exclusion.
    for (const m of sentence.matchAll(QUOTED_RE)) if (norm(m[1]) !== 'out of scope') titles.push(norm(m[1]))
  }
  return titles
}

/**
 * Mark each Out of Scope item that a change order brought into scope. An item is marked only when its title (the words before its first
 * colon) is exactly a title the change order quotes as the exclusion it amends (amendedExclusionTitles). When a change order does not
 * quote one, nothing is marked: the Amendments table still lists the change order, and an unmarked exclusion is the safe reading.
 * Every other exclusion is left exactly as signed.
 */
export function annotateBroughtIntoScope(oosHtml: string, cos: ConformedCo[]): string {
  if (!oosHtml) return oosHtml
  const amended = cos.filter(c => !c.isRenewal).map(c => ({ co: c, titles: amendedExclusionTitles(c.scopeNote) })).filter(x => x.titles.length)
  if (!amended.length) return oosHtml
  return oosHtml.replace(/<(li|p)>([\s\S]*?)<\/\1>/gi, (whole, tag: string, inner: string) => {
    const title = norm(stripTags(inner).split(':')[0] || '')
    if (!title) return whole
    const hit = amended.find(x => x.titles.includes(title))
    if (!hit) return whole
    return `<${tag}>${inner} <em>Amended by ${escapeHtml(ref(hit.co))}: brought into scope for the work that change order describes. This exclusion otherwise stays in place.</em></${tag}>`
  })
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const refList = (cos: ConformedCo[]) => cos.map(ref).join(', ')

/**
 * The signed body keeps stating the ORIGINAL contract value and end date (it must: it is the signed text). So the amended copy adds
 * one clearly marked note under Project Overview saying what they are now, instead of leaving two conflicting figures unexplained.
 */
export function overviewAmendmentNote(cos: ConformedCo[], ctx: { currency: string; revisedNet: number; revisedDate: string | null }): string {
  const date = ctx.revisedDate ? ` and the delivery date is ${escapeHtml(longDate(ctx.revisedDate))}` : ''
  return `<p><em>Amended by ${escapeHtml(refList(cos))}: the contract value is now ${escapeHtml(ctx.currency)} ${money(ctx.revisedNet)} (excluding sales tax)${date}. The figures in this section are as originally signed.</em></p>`
}

/** One note per fee-changing change order under Payment Terms. */
export function paymentAmendmentNote(cos: ConformedCo[], ctx: { currency: string; taxRate: number | null }): string {
  return cos.filter(c => !c.isRenewal && c.netImpact !== 0).map(c => {
    const credit = c.netImpact < 0
    const net = Math.abs(c.netImpact)
    const tax = ctx.taxRate ? ` plus ${ctx.taxRate}% sales tax (${escapeHtml(ctx.currency)} ${money(round2(net * ctx.taxRate / 100))})` : ''
    return `<p><em>Amended by ${escapeHtml(ref(c))}: ${credit ? 'a credit of' : 'an additional fee of'} ${escapeHtml(ctx.currency)} ${money(net)}${tax}, invoiced separately under that change order. The fee and schedule above are as originally signed.</em></p>`
  }).join('')
}

/** A Payment Schedule row for each fee-changing change order, so the schedule and the revised contract value agree. */
export function conformedPaymentScheduleRows(rows: Array<Record<string, unknown>>, cos: ConformedCo[], ctx: { currency: string; taxRate: number | null }): Array<Record<string, unknown>> {
  const out = (rows || []).map(r => ({ ...r }))
  for (const c of cos) {
    if (c.isRenewal || c.netImpact === 0) continue
    const net = Math.abs(c.netImpact)
    const tax = ctx.taxRate ? ` · + ${ctx.taxRate}% tax (${ctx.currency} ${money(round2(net * ctx.taxRate / 100))})` : ''
    out.push({
      milestone: `${ref(c)}: ${c.title}`,
      amount: `${c.netImpact < 0 ? '-' : ''}${ctx.currency} ${money(net)}`,
      trigger: `Invoiced separately under the change order${tax}`,
    })
  }
  return out
}

/** Plain-English one-liner for the amendment table's timeline column. */
export function timelineText(co: ConformedCo): string {
  const parts: string[] = []
  if (co.timelineDays) parts.push(`${co.timelineDays > 0 ? '+' : ''}${co.timelineDays} days`)
  if (co.revisedDeliveryDate) parts.push(`delivery ${longDate(co.revisedDeliveryDate)}`)
  return parts.join(', ') || 'No change'
}
