// lib/documents/co-definition.ts
//
// A change order adds a deliverable the SOW never described, so the SOW's revision policy (written for the original deliverables)
// does not obviously cover it. This is the send-time check that the change order says what happens to changes.

const REVISIONS_STATED_RE = /\brevis(?:e|es|ed|ion|ions)\b|\bre-?work\b|\bfurther change order\b|\banother change order\b|\bnew change order\b|\bchanges?\s+(?:to|after|beyond|requested)\b/i

export const REVISIONS_UNSTATED_WARNING = 'This change order does not say whether the new work includes revisions. The SOW\u2019s revision policy was written for the original deliverables, so state here whether the new work has any, or that changes to it need a further change order, or send it as it is.'

// Only a line that delivers a work product (a list, report, plan, design...) leaves "what happens to changes" open. Hours, posts and other
// repeated units are governed by the SOW as written, so a warning on every priced change order would only train people to click past it.
const WORK_PRODUCT_RE = /\b(short-?lists?|lists?|reports?|briefs?|plans?|audits?|strateg(?:y|ies)|designs?|mock-?ups?|proposals?|analys[ie]s|decks?|documents?|guides?|templates?|copy|scripts?|wireframes?)\b/i

/**
 * Warning for a charged, non-renewal, non-credit change order that delivers a work product (a list, report, plan, design...) whose note,
 * scope impact and lines never mention revisions or changes; otherwise null.
 */
export function revisionsUnstatedWarning(co: {
  is_retainer_renewal?: boolean | null; is_credit?: boolean | null; total?: number | string | null
  note?: string | null; scope_impact_note?: string | null; line_items?: unknown
}): string | null {
  if (co.is_retainer_renewal || co.is_credit || !(Number(co.total) > 0)) return null
  const lines = (Array.isArray(co.line_items) ? co.line_items : []).map((l: any) => String(l?.description ?? '')).join(' ')
  if (!WORK_PRODUCT_RE.test(lines)) return null
  const text = `${String(co.note ?? '').replace(/<[^>]+>/g, ' ')} ${co.scope_impact_note ?? ''} ${lines}`
  return REVISIONS_STATED_RE.test(text) ? null : REVISIONS_UNSTATED_WARNING
}
