// lib/sow/retainer.ts
//
// FIX (SOW lifecycle independent pass 10, B1): for a retainer project, projects.contract_value is the MONTHLY
// fee (see lib/utils/contract-value.ts). Every SOW surface — the PDF header, the portal page the client signs
// on, the signing email, the executed copy, the generator's prompt and fallback — printed that single number
// under the label "Contract value", so a client was asked to sign a "USD 10,000 contract" that is really
// USD 10,000 a month for 24 months. One definition of how a SOW states a retainer's value lives here so no
// surface can drift from another again.

export interface SowRetainerTerms {
  /** True when the project is a retainer — its stored value is a monthly fee. */
  isRetainer: boolean
  /** Fixed term in months, or null for an open-ended retainer. Always null when not a retainer. */
  months: number | null
}

export function sowRetainerTerms(
  project: { type?: string | null; retainer_duration_months?: number | string | null } | null | undefined,
): SowRetainerTerms {
  if (!project || project.type !== 'retainer') return { isRetainer: false, months: null }
  const m = Number(project.retainer_duration_months)
  return { isRetainer: true, months: Number.isFinite(m) && m > 0 ? Math.floor(m) : null }
}

/** monthly fee x term, rounded to cents; null when there is no fixed term (or not a retainer). */
export function sowRetainerTotal(monthly: number, terms: SowRetainerTerms): number | null {
  if (!terms.isRetainer || !terms.months || !Number.isFinite(monthly)) return null
  return Math.round(monthly * terms.months * 100) / 100
}
