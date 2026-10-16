// lib/documents/standard-clauses.ts
//
// Standard clauses written by ScopeGov, not by the model. Termination, Dispute Resolution and Portfolio use used to be model-written,
// and the same inputs produced a different termination date, a different (or no) breach clause, different dispute timing and, for
// portfolio use, opposite rights on different runs. They are fixed here so two SOWs from the same settings say the same thing.
//
// English documents only (other languages keep the model-written text). The wording is a general starting point, not legal advice:
// the Settings tooltip says so, and the agency can edit any section of a draft.

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface TerminationInput { retainer: boolean; retainerMonths?: number | null }

export function terminationClauseHtml(input: TerminationInput): string {
  if (input.retainer) {
    const months = Number(input.retainerMonths)
    const intro = months > 0
      ? `This Statement of Work is a retainer for a term of ${months} month${months === 1 ? '' : 's'}. Either party may end it earlier by giving written notice to the other party.`
      : 'This Statement of Work is an open-ended retainer. Either party may end it by giving written notice to the other party.'
    return `<p>${intro}</p><ul>`
      + '<li>Termination takes effect at the end of the monthly period in which the written notice is given, unless the parties agree a different date in writing.</li>'
      // The retainer is billed monthly IN ADVANCE, so the invoice for the next month can already exist when notice is given. "All
      // fees invoiced up to the effective date" would have made that invoice payable for a month with no service. The fee follows
      // the service period instead: a month that begins on or before the effective date is owed in full, a later one is not.
      + '<li>The Client will pay the monthly fee for each monthly period that begins on or before the effective date of termination, including the period in progress when notice is given. Fees for change orders accepted, and work delivered, before the effective date also remain payable.</li>'
      + '<li>No fee is payable for a monthly period that begins after the effective date of termination. An invoice already issued for such a period is cancelled, and any amount already paid for it is refunded.</li>'
      + '<li>On request after termination, the Provider will return or delete the Client\u2019s account access and materials.</li>'
      + '</ul>'
  }
  return '<p>Either party may end this Statement of Work by giving written notice to the other party.</p><ul>'
    + '<li>Termination takes effect on the date stated in the notice or, if none is stated, on the date the notice is received.</li>'
    + '<li>The Client will pay for all work performed and deliverables completed up to the effective date of termination.</li>'
    + '<li>Either party may also end this Statement of Work by written notice if the other party materially breaches it and does not remedy the breach within a reasonable period after receiving written notice describing it.</li>'
    + '<li>On termination, the Provider will deliver the work completed to date once the fees then due are paid, and will return or delete the Client\u2019s materials on request.</li>'
    + '</ul>'
}

/** `governingLaw` is the phrase as the Governing Law section prints it (with its article: "the State of Texas, United States"). */
export function disputeClauseHtml(governingLaw: string | null | undefined): string {
  const law = String(governingLaw ?? '').trim()
  const courts = law ? `the competent courts of ${esc(law)}` : 'the competent courts of the governing jurisdiction'
  return '<p>The parties will resolve any dispute arising out of this Statement of Work in the following order:</p><ul>'
    + '<li><strong>Negotiation:</strong> The parties\u2019 authorized representatives will first attempt in good faith to resolve the dispute through direct discussion.</li>'
    + '<li><strong>Mediation:</strong> If negotiation does not resolve the dispute, the parties will submit it to non-binding mediation before a mutually agreed mediator, with the mediator\u2019s fees shared equally.</li>'
    + `<li><strong>Courts:</strong> If mediation does not resolve the dispute, either party may bring proceedings in ${courts}.</li>`
    + '</ul>'
}

// ── Portfolio use ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type PortfolioUse = 'with_consent' | 'unless_objects'

export function normalizePortfolioUse(value: unknown): PortfolioUse | null {
  return value === 'with_consent' || value === 'unless_objects' ? value : null
}

export const PORTFOLIO_USE_LEAD = 'Portfolio use.'

export function portfolioUseSentence(mode: PortfolioUse): string {
  return mode === 'with_consent'
    ? 'The Provider may refer to this engagement in its portfolio only with the Client\u2019s prior written consent.'
    : 'The Provider may reference the published work as work samples unless the Client objects in writing.'
}

const PORTFOLIO_RE = /\b(portfolio|work samples?|case stud(?:y|ies)|showcase|publicity|promotional (?:use|purposes)|marketing (?:use|purposes) by the provider)\b/i
const plain = (s: string) => s.replace(/<[^>]+>/g, '')

/**
 * Removes portfolio / publicity wording the model volunteered: a right nobody supplied, and one it decided in opposite directions on
 * different runs. Works on <li> items and on the sentences of a <p>; a paragraph left with nothing but its bold lead goes too.
 */
export function stripPortfolioWording(html: string): string {
  if (typeof html !== 'string' || !PORTFOLIO_RE.test(plain(html))) return html
  const noItems = html.replace(/<li>([\s\S]*?)<\/li>/gi, (whole, inner: string) => (PORTFOLIO_RE.test(plain(inner)) ? '' : whole))
  return noItems.replace(/<p>([\s\S]*?)<\/p>/gi, (whole, inner: string) => {
    if (!PORTFOLIO_RE.test(plain(inner))) return whole
    const kept = inner.split(/(?<=[.!?])\s+/).filter(sent => !PORTFOLIO_RE.test(plain(sent)))
    const body = kept.join(' ').trim()
    const onlyLead = !body || /^<(strong|b)>[\s\S]*?<\/\1>$/i.test(body)
    return onlyLead ? '' : `<p>${body}</p>`
  }).replace(/<ul>\s*<\/ul>/gi, '')
}

/** English only: strip anything the model wrote on the subject, then add the chosen sentence (if any) as its own paragraph. */
export function applyPortfolioUse(ipHtml: string, mode: PortfolioUse | null, language: string | null | undefined): string {
  if (language && language !== 'en') return ipHtml
  const base = stripPortfolioWording(ipHtml || '')
  return mode ? `${base}<p><strong>${PORTFOLIO_USE_LEAD}</strong> ${esc(portfolioUseSentence(mode))}</p>` : base
}
