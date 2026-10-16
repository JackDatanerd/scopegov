// lib/documents/client-materials.ts
//
// Three things a SOW needs whenever the Client supplies material or data the work depends on, kept in one place:
//
//  1. Client-materials terms (optional, chosen in Settings): the Client confirms it holds the rights and consents needed for the
//     Provider to edit and publish what it supplies, and licenses the Provider to use it for the services. On a retainer, a second
//     sentence says what happens to a recurring deliverable when the supply does not arrive. Fixed wording, never model-written,
//     frozen into the SOW. English only.
//  2. Data access: a deliverable that reports on data the Provider does not control (store traffic, sales, referrals) needs the Client
//     to give access to where that data lives. The drafting prompt asks for it, and the send check flags a SOW that promises the
//     report without it.
//  3. Review window against cadence: a review period longer than the delivery cadence lets deliverables pile up or go out late.

export type ClientMaterialsTerms = 'standard'

export function normalizeClientMaterialsTerms(value: unknown): ClientMaterialsTerms | null {
  return value === 'standard' ? 'standard' : null
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const plain = (html: string) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

export const CLIENT_MATERIALS_LEAD = 'Client materials.'
export const SUPPLY_SHORTFALL_LEAD = 'Supply of materials.'

export function clientMaterialsSentence(): string {
  return 'The Client confirms that it owns, or has obtained, all rights, licences, consents and releases needed for the Provider to edit and publish the materials the Client supplies (including from anyone who appears in or created them), and is responsible for any third-party claim that those materials, used as the Client supplied them, infringe that party\u2019s rights. The Client grants the Provider a non-exclusive licence to use those materials to perform the services.'
}

export function supplyShortfallSentence(): string {
  return 'If the Client does not supply the materials a recurring deliverable depends on in time, the Provider delivers only what the supplied materials allow for that period. The monthly fee is unchanged, and any shortfall is not carried over or credited unless the parties agree otherwise in writing.'
}

const english = (language: string | null | undefined) => !language || language === 'en'

/** Intellectual Property with the client-materials paragraph added once (idempotent). Unchanged when the setting is off or the SOW is not English. */
export function applyClientMaterialsTerms(ipHtml: string, terms: ClientMaterialsTerms | null, language?: string | null): string {
  if (!terms || !english(language)) return ipHtml
  if (plain(ipHtml).includes(plain(esc(clientMaterialsSentence())))) return ipHtml
  return `${ipHtml}<p><strong>${CLIENT_MATERIALS_LEAD}</strong> ${esc(clientMaterialsSentence())}</p>`
}

/** Assumptions with the supply-shortfall paragraph added once, for a retainer only. */
export function applySupplyShortfall(assumptionsHtml: string, terms: ClientMaterialsTerms | null, retainer: boolean, language?: string | null): string {
  if (!terms || !retainer || !english(language)) return assumptionsHtml
  if (plain(assumptionsHtml).includes(plain(esc(supplyShortfallSentence())))) return assumptionsHtml
  return `${assumptionsHtml}<p><strong>${SUPPLY_SHORTFALL_LEAD}</strong> ${esc(supplyShortfallSentence())}</p>`
}

// ── Data access ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const REPORTS_RE = /\b(report(?:s|ed|ing)?|track(?:s|ed|ing)?|measur(?:e|es|ed|ing))\b/i
const EXTERNAL_DATA_RE = /\b(traffic|referrals?|analytics|conversions?|sales|revenue|click-?throughs?|sessions?)\b/i
const ACCESS_RE = /\b(analytics|shopify|google analytics|ga4|utm|referral|traffic|store|website|dashboard|data|insights)\b[^.]{0,60}\b(access|read-?only|view-?only|export|exports|shared?)\b|\b(access|read-?only|view-?only|exports?)\b[^.]{0,60}\b(analytics|shopify|google analytics|ga4|referral|traffic|store|website|dashboard|data|insights)\b/i

/** True when the text promises to report on traffic, sales or similar data that lives outside the accounts the Provider manages. */
export function reportsOnExternalData(text: string): boolean {
  return REPORTS_RE.test(text) && EXTERNAL_DATA_RE.test(text)
}

/** True when the text says the Client gives access to (or exports) the data a report needs. */
export function dataAccessStated(text: string): boolean {
  return ACCESS_RE.test(text)
}

export const DATA_ACCESS_WARNING = 'A deliverable promises to report on traffic, sales or similar data, but nothing in this SOW says the Client gives the Provider access to where that data lives (for example view-only store analytics, or a regular export). Add it to the Client\u2019s dependencies so the report can be produced, and state that the access is view-only if store administration is out of scope.'

/** One drafting-prompt rule, only when the brief promises such a report. Empty otherwise and for non-English SOWs. */
export function dataAccessPromptLine(input: { objective?: string; deliverables?: string; language?: string }): string {
  if (!english(input.language)) return ''
  if (!reportsOnExternalData(`${input.objective ?? ''} ${input.deliverables ?? ''}`)) return ''
  return '- A deliverable reports on data the Provider does not control (traffic, referrals, sales or similar). The Client must therefore give the Provider view-only access to where that data lives, or a regular export of it. Give it its own row in the Roles table and its own Assumption, due on the same date as the Client\'s account access, and state that the access is view-only and is not administration of any store or system.'
}

// ── Review window against cadence ────────────────────────────────────────────────────────────────────────────────────────────
const RECURRING_RE = /\b(weekly|daily|every\s+week|each\s+week|per\s+week|a\s+week)\b/i

/** Business days in one working week. A review period longer than this outlasts a weekly cadence. */
export const WORKING_WEEK_DAYS = 5

/** Warning when the Client's review period is longer than the cadence of a recurring deliverable; otherwise null. */
export function reviewWindowCadenceWarning(reviewDays: unknown, deliverablesText: string): string | null {
  const d = Number(reviewDays)
  if (!Number.isInteger(d) || d <= WORKING_WEEK_DAYS) return null
  if (!RECURRING_RE.test(deliverablesText)) return null
  return `The Client has ${d} business days to review each deliverable, but at least one deliverable recurs weekly or more often. Reviews would outlast the cadence, so work can pile up or go out late. Shorten the review window in Settings, or confirm this is intended.`
}
