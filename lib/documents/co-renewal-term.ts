// lib/documents/co-renewal-term.ts
//
// CO-1: accepting a retainer-renewal change order extends projects.retainer_duration_months by the renewal's stated
// months (lib/documents/finalize-co.ts) - a binding change to how long the client is committed. That term was never
// printed on the document the client signs (the PDF stated only the old and new monthly rate), never shown on the
// portal, never in the signing email and never part of the content hash. One rule for "does this document state a term",
// shared by every surface, and the same one the send gate (renewalNeedsTerm) and the finalizer apply: only a renewal on a
// FIXED-term retainer has an end to extend, so an open-ended retainer states none.

export function renewalTermForDocument(
  co: { is_retainer_renewal?: boolean | null; renewal_term_months?: number | string | null },
  project: { type?: string | null; retainer_duration_months?: number | string | null } | null | undefined,
): number | null {
  if (!co.is_retainer_renewal || project?.type !== 'retainer') return null
  if (!(Number(project?.retainer_duration_months) > 0)) return null
  const term = Number(co.renewal_term_months)
  return Number.isInteger(term) && term > 0 ? term : null
}

/** "12 months" / "1 month" - how a renewal's term reads on a document. */
export function formatRenewalTerm(months: number): string {
  return `${months} month${months === 1 ? '' : 's'}`
}
