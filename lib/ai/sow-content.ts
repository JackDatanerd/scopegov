// lib/ai/sow-content.ts
//
// FIX (re-audit — "AI returned invalid JSON. Please try again."): the old
// approach asked the model to author an entire 14-section legal document
// AND correctly hand-escape every quote/apostrophe/tag inside a single
// giant JSON envelope, in one shot, then did `JSON.parse` with no retry
// and no fallback. Any single mistake anywhere in ~8000 tokens of legal
// prose discarded the whole document and dead-ended the user.
//
// New approach, in order of what actually moves the reliability needle:
//  1. The server owns the section structure and JSON shape completely.
//     The model is never asked to produce JSON at all — only plain
//     delimited content, which is far more forgiving to parse (a stray
//     preamble sentence or markdown fence doesn't invalidate anything,
//     since we only look for known markers, not overall syntactic
//     validity).
//  2. Three of the fifteen sections (parties / governing_law / signature)
//     were already fully hardcoded boilerplate in the old prompt's JSON
//     template — the model was never actually asked to draft them. That
//     didn't change; it's just built here in code now instead of being
//     smuggled into a "one shot" prompt.
//  3. If the model's output still doesn't parse after a couple of quick,
//     silent retries, `buildFallbackSections()` / `buildFallbackTables()`
//     produce a complete, usable SOW directly from the brief fields with
//     zero AI involvement — guaranteed to succeed. The Generate SOW
//     button must never be able to hard-fail the user; AI makes the
//     result better, it doesn't gate whether a result exists. Per-section
//     AI polish afterward (sow/regenerate-section) is the place to retry
//     quality, not this endpoint.
//
// FIX (doc-quality audit, Aug 2026): Deliverables, Timeline, and the new
// Roles & Responsibilities section no longer generate prose — they
// generate structured table rows (see lib/sow/table-schema.ts), because
// that's what actually reads as a professional SOW instead of a wall of
// text. The model is asked for pipe-delimited rows under a TABLE marker,
// same tolerant-parsing philosophy as the prose sections: if a row is
// malformed it's dropped, not fatal to the whole document.

import { normalizeLateFeeRate, lateFeeContractSentence } from '@/lib/documents/late-fee'
import { normalizeLiabilityCap, liabilityCapSentence, LIABILITY_CAP_LEAD, type LiabilityCap } from '@/lib/documents/liability-cap'
import { escapeHtml, sanitizePlainText, truncateText } from '@/lib/utils/sanitize'
import { isBlankText } from '@/lib/utils/client-input'
import { amountsStated } from '@/lib/sow/validate-send'
import { SOW_TABLE_SCHEMAS, type SowTableSectionId, type SowTableRow } from '@/lib/sow/table-schema'
import { roundCurrency } from '@/lib/utils/format'

export interface SowSectionDef { id: string; title: string; order: number }

// Full, server-owned section list — the only place this ordering is
// defined. Nothing about it is ever requested from the model.
export const SOW_SECTION_DEFS: SowSectionDef[] = [
  { id: 'parties',         title: 'Parties',                    order: 1 },
  { id: 'overview',        title: 'Project Overview',           order: 2 },
  { id: 'deliverables',    title: 'Deliverables',                order: 3 },
  { id: 'oos',             title: 'Out of Scope',                order: 4 },
  { id: 'timeline',        title: 'Timeline & Milestones',       order: 5 },
  { id: 'roles',           title: 'Roles & Responsibilities',    order: 6 },
  { id: 'assumptions',     title: 'Assumptions & Dependencies',  order: 7 },
  { id: 'payment',         title: 'Payment Terms',               order: 8 },
  // FEATURE (section-9 audit follow-up): see lib/sow/table-schema.ts for
  // the full history. Always created (like every other section) but only
  // shown by default when paymentStructure === 'milestones' — see
  // app/api/sow/generate/route.ts, which sets its initial `visible` flag.
  { id: 'payment_schedule', title: 'Payment Schedule',          order: 9 },
  { id: 'revisions',       title: 'Revision Policy',             order: 10 },
  { id: 'ip',              title: 'Intellectual Property',       order: 11 },
  { id: 'confidentiality', title: 'Confidentiality',             order: 12 },
  { id: 'termination',     title: 'Termination',                 order: 13 },
  { id: 'governing_law',   title: 'Governing Law',               order: 14 },
  { id: 'dispute',         title: 'Dispute Resolution',          order: 15 },
  { id: 'signature',       title: 'Signatures',                  order: 16 },
]

// Table-driven sections (defined in lib/sow/table-schema.ts) — never
// asked of the model as prose. Keep in sync with SowTableSectionId /
// TABLE_SECTION_IDS in lib/sow/table-schema.ts.
const TABLE_IDS: SowTableSectionId[] = ['deliverables', 'timeline', 'roles', 'payment_schedule']

// The prose subset that needs drafted content. parties/governing_law/
// signature are pure boilerplate (see buildBoilerplateSections below);
// deliverables/timeline/roles are structured tables (see below).
export const AI_SECTION_IDS = SOW_SECTION_DEFS
  .map(s => s.id)
  .filter(id => !['parties', 'governing_law', 'signature', ...TABLE_IDS].includes(id))

export interface SowContentInput {
  agencyName: string
  clientName: string
  projectName: string
  projectDisc?: string | null
  projectType: string
  contractValue: string | number
  // B1 (pass 10): set for a retainer project, whose contractValue is the MONTHLY fee. months null = open-ended.
  retainer?: { months: number | null } | null
  currency: string
  objective?: string
  deliverables?: string
  outOfScope?: string
  timeline?: string
  paymentLabel: string
  // FEATURE (section-9 audit follow-up): raw structure value (not just
  // the human-readable label) so the prompt/fallback builders can decide
  // whether to draft a payment-schedule table at all — only meaningful
  // when the agency actually chose 'milestones'.
  paymentStructure: string
  revisionRounds: number
  governingLaw: string
  // FIX (deep audit, section 5 re-pass): completes the SOW-language
  // feature. workspaces.sow_language existed, was writable from Settings
  // API-side, and was even already selected (unused) inside
  // app/api/sow/generate/route.ts's own query — but nothing threaded it
  // through to generation. Defaults to English so every existing caller
  // that doesn't pass this keeps behaving exactly as before.
  language?: string
  // The agency's saved standard terms (workspace_defaults, edited under Settings →
  // Defaults). The columns existed and were editable, but generation never read them, so
  // an agency's own standard exclusions / assumptions / revision and payment wording
  // never reached a SOW unless the model happened to repeat them.
  standards?: AgencyStandards | null
  // The person who signs for the client when the client is a company (clientName is then the company).
  // Collected before generation so the Parties clause and every prompt rule name the right legal party.
  clientRepresentative?: string | null
  clientRepresentativeTitle?: string | null
  // The workspace's tax setting at generation time. Without it the model never learned that tax applies, so the
  // Payment Terms stated a net figure while every invoice added tax on top.
  tax?: { rate: number; inclusive: boolean } | null
  // Calendar-date style for drafted prose; must match how the PDF prints dates (see lib/pdf/renderer.tsx).
  dateStyle?: 'us' | 'intl'
  // Late fee, percent per month on overdue amounts (workspace setting at drafting). Null/absent = none: the Payment Terms
  // then say nothing about one, and the prompt keeps forbidding the model from inventing it.
  lateFeeRate?: number | null
  // Workspace standard payment terms (days from invoice date to due date). Null/absent = the SOW says nothing about it.
  // Invoices and change orders already print this period, so the SOW the client signs must state the same one.
  paymentTermsDays?: number | null
  // Optional limitation-of-liability clause chosen in settings; app-owned wording, appended deterministically to Termination.
  liabilityCap?: LiabilityCap | null
}

export interface AgencyStandards {
  revisionPolicy?: string | null
  paymentTerms?: string | null
  outOfScopeClauses?: string[] | null
  assumptions?: string[] | null
}

const norm = (t: string) => t.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

// Settings independent pass 13: text with nothing visible in it (zero-width / bidi / filler characters) is blank —
// a saved standard made of those used to be appended to the SOW as an empty bullet or paragraph.
const visibleText = (t: string): string => (isBlankText(t) ? '' : t)

function cleanClauses(list: string[] | null | undefined): string[] {
  return (Array.isArray(list) ? list : [])
    .map(c => visibleText(truncateText(sanitizePlainText(String(c ?? '')), 500)))
    .filter(Boolean)
    .slice(0, 30)
}

/** Prompt text telling the model which agency-standard terms must appear. */
export function standardsPromptBlock(standards: AgencyStandards | null | undefined): string {
  if (!standards) return ''
  const lines: string[] = []
  const oos = cleanClauses(standards.outOfScopeClauses)
  const assumptions = cleanClauses(standards.assumptions)
  if (oos.length) lines.push(`- The agency's standard exclusions — include EACH of these in the Out of Scope section as its own item, in addition to the project-specific ones:\n${oos.map(c => `    • ${c}`).join('\n')}`)
  if (assumptions.length) lines.push(`- The agency's standard assumptions — include EACH in the Assumptions section:\n${assumptions.map(c => `    • ${c}`).join('\n')}`)
  const rp = visibleText(truncateText(sanitizePlainText(standards.revisionPolicy || ''), 1500))
  if (rp) lines.push(`- The agency's standard revision-policy wording — reflect it in the Revision Policy section: "${rp}"`)
  const pt = visibleText(truncateText(sanitizePlainText(standards.paymentTerms || ''), 1500))
  if (pt) lines.push(`- The agency's standard payment-terms wording — reflect it in the Payment section without changing any amount: "${pt}"`)
  return lines.length ? `\n${lines.join('\n')}` : ''
}

// FIX (fresh independent audit, section 9): a revision-policy standard
// almost always states its own round count in the same "N round(s)"
// phrasing this app's own AI prompt and deterministic fallback both use
// (see FALLBACK_STRINGS.revisions and the prompt rule "Revision policy
// must reference exactly N revision round(s)" below) — so appending it
// unconditionally onto a Revision Policy section that has ALREADY stated
// the project's real, validated revisionRounds produces a document that
// states two different round counts in the same section. Scoped tightly
// to the "<number> round(s)" phrasing specifically (not a bare digit
// anywhere in the text) so a standard that mentions an unrelated number —
// "revisions must be requested within 5 business days" — is never
// mistaken for a conflict and still gets appended normally.
// FIX (SOW lifecycle independent pass 22, B3): this only matched a digit IMMEDIATELY before "round(s)". A standard written
// "3 revision rounds", "Three rounds of revisions", "two (2) rounds", "3 rondas de revisión" or "3 Überarbeitungsrunden" slipped
// through, so the policy was appended under the project's own "2 rounds" sentence and the Revision Policy section stated two
// different counts. Detection now also accepts spelled-out numbers (en/es/fr/pt/de/sw), a "(n)" echo, a few revision-related
// words between the number and "round", and the localized nouns. The middle words are deliberately a closed list: "one
// additional round" or "within 5 days of each round" must still NOT read as a conflicting round count.
const ROUND_NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10,
  um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, quatro: 4, sete: 7, oito: 8, dez: 10,
  eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, sechs: 6, sieben: 7, acht: 8, zehn: 10,
  moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10,
}
const ROUND_COUNT_RE = (() => {
  const words = Object.keys(ROUND_NUMBER_WORDS).sort((x, y) => y.length - x.length).join('|')
  const middle = '(?:(?:revisions?|reviews?|feedback|designs?|edits?|amendments?|changes?)\\s+)?'
  const noun = '(?:\\p{L}*runden?|rounds?|rondas?|rodadas?|tours?|s[ée]ries?|mizunguko|mzunguko)'
  return new RegExp(`(?<![\\p{L}\\d])(\\d+|${words})(?:\\s*\\(\\d+\\))?\\s+${middle}${noun}(?![\\p{L}])`, 'giu')
})()

function conflictingRoundCount(text: string, revisionRounds: number): boolean {
  const matches = Array.from(text.matchAll(ROUND_COUNT_RE))
  for (const m of matches) {
    const token = m[1].toLowerCase()
    const n = /^\d+$/.test(token) ? Number(token) : ROUND_NUMBER_WORDS[token]
    if (Number.isFinite(n) && n !== revisionRounds) return true
  }
  return false
}

/**
 * Guarantees the agency's standard terms are present after generation, whether the text came
 * from the model or the deterministic fallback: any clause not already in the section is
 * appended. Pure and idempotent.
 */
export function applyAgencyStandards(
  content: Record<string, string>,
  standards: AgencyStandards | null | undefined,
  // FIX (fresh independent audit, section 9): needed so the revisions paragraph below can
  // detect — and skip appending on — a round-count conflict. Optional so any other caller
  // (there are none today, but this is an exported helper) keeps working unchanged; the
  // conflict check simply doesn't run without it.
  revisionRounds?: number,
): Record<string, string> {
  if (!standards) return content
  const out = { ...content }
  const addList = (id: string, clauses: string[]) => {
    const existing = norm(out[id] || '')
    const missing = clauses.filter(c => !existing.includes(norm(c)))
    if (missing.length) out[id] = `${out[id] || ''}<ul>${missing.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
  }
  const addParagraph = (id: string, text: string) => {
    if (text && !norm(out[id] || '').includes(norm(text).slice(0, 80))) out[id] = `${out[id] || ''}<p>${escapeHtml(text)}</p>`
  }
  addList('oos', cleanClauses(standards.outOfScopeClauses))
  addList('assumptions', cleanClauses(standards.assumptions))
  const revisionPolicy = visibleText(truncateText(sanitizePlainText(standards.revisionPolicy || ''), 1500))
  // FIX (fresh independent audit, section 9): skip the append rather than let the document
  // state two different revision-round counts in the same section — see
  // conflictingRoundCount's own comment. Nothing else downstream (validate-send.ts included)
  // ever cross-checks the Revision Policy section's prose against metadata.revisionRounds, so
  // this is the only place that can catch it.
  if (!(typeof revisionRounds === 'number' && conflictingRoundCount(revisionPolicy, revisionRounds))) {
    addParagraph('revisions', revisionPolicy)
  }
  addParagraph('payment', visibleText(truncateText(sanitizePlainText(standards.paymentTerms || ''), 1500)))
  return out
}

/**
 * The Payment Terms prose is model-written, but the contract value is data. If the prose does
 * not state the agreed value (the model paraphrased, skipped it, or the value changed after
 * drafting), append one deterministic sentence so the document can never disagree with itself.
 */
export function ensureContractValueStated(paymentHtml: string, contractValue: number, currency: string, retainer?: { months: number | null } | null): string {
  if (!Number.isFinite(contractValue) || contractValue <= 0) return paymentHtml
  const stated = amountsStated(norm(paymentHtml)).some(n => Math.abs(n - contractValue) < 0.01)
  if (stated) return paymentHtml
  const pretty = contractValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  // B1 (pass 10): a retainer's stored value is the MONTHLY fee — never append it as if it were a one-off total.
  return `${paymentHtml}<p><strong>${escapeHtml(currency)} ${pretty}${retainer ? ' / month' : ''}</strong></p>`
}

// Supported SOW languages and the model-facing name used in the prompt
// instruction. Must stay in sync with the curated list in
// components/settings/SettingsClient.tsx (SOW_LANGUAGES) and the
// server-side validation in app/api/workspace/settings/route.ts — each
// entry needs a matching translation below, so this is deliberately a
// closed set rather than accepting arbitrary language codes.
export const SOW_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', pt: 'Portuguese', de: 'German', sw: 'Swahili',
}

// FIX (fresh independent audit, section 4): every lookup/validation against the map above
// used `code in SOW_LANGUAGE_NAMES` or a bare `SOW_LANGUAGE_NAMES[code]`. Both walk the
// prototype chain, so a code like 'toString' or 'constructor' "exists" — workspace/defaults
// accepted it and wrote it to workspaces.sow_language, after which BOILERPLATE_TEMPLATES[code]
// resolved to Object.prototype.toString (truthy, so the `|| BOILERPLATE_TEMPLATES.en`
// fallback never fired) and generation broke. Own-property checks only.
export function isSowLanguage(code: unknown): code is string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(SOW_LANGUAGE_NAMES, code)
}

/** Display name for a supported SOW language code, or undefined for anything else. */
export function sowLanguageName(code: unknown): string | undefined {
  return isSowLanguage(code) ? SOW_LANGUAGE_NAMES[code] : undefined
}


// ── Money / tax / wording helpers shared by the prompt, the fallbacks and the Payment Schedule ──

/** "USD 4,000.00" — the one format every contract figure is written in. */
export function formatMoneyText(currency: string, value: unknown): string {
  const n = Number(value)
  const body = Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value)
  return `${currency} ${body}`
}

/** "State of Texas, United States" -> "the State of Texas, United States"; "Kenya" stays "Kenya". */
export function lawWithArticle(law: string): string {
  const t = String(law || '').trim()
  if (!t || /^the\s/i.test(t)) return t
  return /^(state|commonwealth|republic|kingdom|province|federation|united|district|territory|city|people'?s|principality|duchy|emirate|sultanate)\b/i.test(t) ? `the ${t}` : t
}

export interface TaxSplit { net: number; tax: number; gross: number }

/** Net / tax / gross for an amount entered the way the workspace enters it (net when tax is exclusive, gross when inclusive). */
export function splitTax(entered: number, tax: SowContentInput['tax']): TaxSplit {
  const amount = roundCurrency(entered)
  const rate = tax && tax.rate > 0 ? tax.rate : 0
  if (!rate) return { net: amount, tax: 0, gross: amount }
  if (tax!.inclusive) {
    const net = roundCurrency(amount / (1 + rate / 100))
    return { net, tax: roundCurrency(amount - net), gross: amount }
  }
  const gross = roundCurrency(amount * (1 + rate / 100))
  return { net: amount, tax: roundCurrency(gross - amount), gross }
}

export interface PaymentInstalment { title: string; trigger: string; amount: number }

/** The instalments a NON-milestone structure bills — same split createSowMilestones uses (first half rounded, remainder last). */
export function structureInstalments(structure: string, contractValue: number): PaymentInstalment[] {
  const cv = roundCurrency(contractValue)
  if (structure === '50_50') {
    const upfront = roundCurrency(cv * 0.5)
    return [
      { title: 'Upfront payment (50%)', trigger: 'Before work commences', amount: upfront },
      { title: 'Final payment (50%)', trigger: 'Final delivery approval', amount: roundCurrency(cv - upfront) },
    ]
  }
  if (structure === '100_upfront') return [{ title: 'Full payment', trigger: 'Before work commences', amount: cv }]
  if (structure === 'on_delivery') return [{ title: 'Full payment', trigger: 'Final delivery approval', amount: cv }]
  if (structure === 'monthly') return [{ title: 'Monthly retainer', trigger: 'Monthly — first of month', amount: cv }]
  return []
}

/** Prompt lines stating how tax applies, with the exact figures the Payment Terms must carry. Empty when no tax applies. */
export function taxPromptBlock(input: SowContentInput): string {
  const tax = input.tax
  if (!tax || !(tax.rate > 0) || input.retainer) return ''
  const cv = Number(input.contractValue)
  if (!Number.isFinite(cv) || cv <= 0) return ''
  const whole = splitTax(cv, tax)
  const money = (n: number) => formatMoneyText(input.currency, n)
  const lines = [
    tax.inclusive
      ? `Sales tax: ${tax.rate}% is INCLUDED in the contract value. Contract value ${money(whole.gross)} includes ${money(whole.tax)} of tax (net ${money(whole.net)}).`
      : `Sales tax: ${tax.rate}% is charged IN ADDITION to the contract value. Contract value (excluding tax) ${money(whole.net)}; tax ${money(whole.tax)}; total payable including tax ${money(whole.gross)}.`,
  ]
  const instalments = structureInstalments(input.paymentStructure, cv)
  if (instalments.length > 1) {
    lines.push('Instalments (use exactly these figures):')
    for (const it of instalments) {
      const sp = splitTax(it.amount, tax)
      lines.push(tax.inclusive
        ? `  - ${it.title}: ${money(sp.gross)} (includes ${money(sp.tax)} tax)`
        : `  - ${it.title}: ${money(sp.net)} plus ${money(sp.tax)} tax = ${money(sp.gross)}`)
    }
  }
  return lines.join('\n')
}

/** One deterministic sentence for the Payment Terms: how tax applies. Empty when no tax applies. */
export function taxSentenceHtml(input: SowContentInput): string {
  const tax = input.tax
  if (!tax || !(tax.rate > 0) || input.retainer) return ''
  const cv = Number(input.contractValue)
  if (!Number.isFinite(cv) || cv <= 0) return ''
  const sp = splitTax(cv, tax)
  const money = (n: number) => escapeHtml(formatMoneyText(input.currency, n))
  return tax.inclusive
    ? `<p>All amounts include sales tax at ${tax.rate}% (${money(sp.tax)} of the ${money(sp.gross)} contract value).</p>`
    : `<p>All amounts are stated exclusive of sales tax. Sales tax at ${tax.rate}% (${money(sp.tax)} on the ${money(sp.net)} contract value) is added to each invoice, for a total payable of ${money(sp.gross)}.</p>`
}

/** Backstop for the model: if the Payment Terms never mention the tax rate, append the deterministic sentence. */
export function ensureTaxStated(paymentHtml: string, input: SowContentInput): string {
  // The appended sentence is English; a drafted-in-another-language SOW relies on the prompt rule instead.
  if (input.language && input.language !== 'en') return paymentHtml
  const sentence = taxSentenceHtml(input)
  if (!sentence) return paymentHtml
  const rate = String(input.tax!.rate).replace('.', '\\.')
  if (new RegExp(`${rate}\\s*%`).test(norm(paymentHtml))) return paymentHtml
  return `${paymentHtml}${sentence}`
}


/** Whole number of days, 1-365, or null. */
export function normalizePaymentTermsDays(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null
}

/** One deterministic contract sentence for when invoices fall due. Empty when the workspace sets no standard term. */
export function paymentTermsSentenceHtml(input: SowContentInput): string {
  const d = normalizePaymentTermsDays(input.paymentTermsDays)
  return d ? `<p>Each invoice is due within ${d} day${d === 1 ? '' : 's'} of its invoice date.</p>` : ''
}

/** Prompt line: the same period the invoices print, and consistent trigger wording. Empty when no term is set. */
export function paymentTermsPromptBlock(input: SowContentInput): string {
  const d = normalizePaymentTermsDays(input.paymentTermsDays)
  return d
    ? `Payment timing: each invoice is payable within ${d} day${d === 1 ? '' : 's'} of its invoice date. Describe each instalment by WHEN ITS INVOICE IS ISSUED (for example "invoiced before work commences", "invoiced on final delivery approval") and never as "due upfront" or "due on delivery", which would contradict that period.`
    : ''
}

/** Backstop for the model: append the payment-period sentence when the Payment Terms never state a day count. English only. */
export function ensurePaymentTermsDaysStated(paymentHtml: string, input: SowContentInput): string {
  if (input.language && input.language !== 'en') return paymentHtml
  const d = normalizePaymentTermsDays(input.paymentTermsDays)
  if (!d) return paymentHtml
  if (new RegExp(`within\\s+${d}\\s+days?\\b|net\\s*${d}\\b`, 'i').test(norm(paymentHtml))) return paymentHtml
  return `${paymentHtml}${paymentTermsSentenceHtml(input)}`
}

/** One deterministic contract sentence for the late fee. Empty when the agency charges none. */
export function lateFeeSentenceHtml(input: SowContentInput): string {
  const rate = normalizeLateFeeRate(input.lateFeeRate)
  return rate ? `<p>${escapeHtml(lateFeeContractSentence(rate))}</p>` : ''
}

/** Prompt line giving the model the exact late-fee wording. Empty when none applies. */
export function lateFeePromptBlock(input: SowContentInput): string {
  const rate = normalizeLateFeeRate(input.lateFeeRate)
  return rate ? `Late fee: the Payment Terms must state, exactly once and in these words: "${lateFeeContractSentence(rate)}"` : ''
}

/** Backstop for the model: append the late-fee sentence when the Payment Terms never state the rate. English only. */
export function ensureLateFeeStated(paymentHtml: string, input: SowContentInput): string {
  if (input.language && input.language !== 'en') return paymentHtml
  const rate = normalizeLateFeeRate(input.lateFeeRate)
  if (!rate) return paymentHtml
  const r = String(rate).replace('.', '\\.')
  const text = norm(paymentHtml)
  if (new RegExp(`late[^.]{0,120}${r}\\s*%|${r}\\s*%[^.]{0,120}late`, 'i').test(text)) return paymentHtml
  return `${paymentHtml}${lateFeeSentenceHtml(input)}`
}


/** The fixed limitation-of-liability paragraph. Empty when none is chosen or the document isn't English. */
export function liabilityCapHtml(input: SowContentInput): string {
  if (input.language && input.language !== 'en') return ''
  const cap = normalizeLiabilityCap(input.liabilityCap)
  return cap ? `<p><strong>${LIABILITY_CAP_LEAD}</strong> ${escapeHtml(liabilityCapSentence(cap))}</p>` : ''
}

/** Append the chosen clause to the Termination text unless that exact clause is already there. */
export function ensureLiabilityCapStated(terminationHtml: string, input: SowContentInput): string {
  const clause = liabilityCapHtml(input)
  if (!clause) return terminationHtml
  const cap = normalizeLiabilityCap(input.liabilityCap)!
  if (norm(terminationHtml).includes(norm(escapeHtml(liabilityCapSentence(cap))))) return terminationHtml
  return `${terminationHtml}${clause}`
}

const SCHEDULE_WORDS: Record<string, { upfront: string; final: string; full: string; monthly: string; kickoff: string; beforeWork: string; finalApproval: string; monthlyTrig: string; tax: string }> = {
  en: { upfront: 'Upfront payment (50%)', final: 'Final payment (50%)', full: 'Full payment', monthly: 'Monthly retainer', kickoff: 'Before work commences', beforeWork: 'Before work commences', finalApproval: 'Final delivery approval', monthlyTrig: 'Monthly — first of month', tax: 'tax' },
  es: { upfront: 'Pago inicial (50%)', final: 'Pago final (50%)', full: 'Pago total', monthly: 'Iguala mensual', kickoff: 'Antes de comenzar el trabajo', beforeWork: 'Antes de comenzar el trabajo', finalApproval: 'Aprobación de la entrega final', monthlyTrig: 'Mensual — primer día del mes', tax: 'impuesto' },
  fr: { upfront: 'Acompte (50 %)', final: 'Paiement final (50 %)', full: 'Paiement intégral', monthly: 'Forfait mensuel', kickoff: 'Avant le début des travaux', beforeWork: 'Avant le début des travaux', finalApproval: 'Approbation de la livraison finale', monthlyTrig: 'Mensuel — le premier du mois', tax: 'taxe' },
  pt: { upfront: 'Pagamento inicial (50%)', final: 'Pagamento final (50%)', full: 'Pagamento integral', monthly: 'Retainer mensal', kickoff: 'Antes do início do trabalho', beforeWork: 'Antes do início do trabalho', finalApproval: 'Aprovação da entrega final', monthlyTrig: 'Mensal — primeiro dia do mês', tax: 'imposto' },
  de: { upfront: 'Anzahlung (50 %)', final: 'Schlusszahlung (50 %)', full: 'Gesamtzahlung', monthly: 'Monatlicher Retainer', kickoff: 'Vor Arbeitsbeginn', beforeWork: 'Vor Arbeitsbeginn', finalApproval: 'Freigabe der Endlieferung', monthlyTrig: 'Monatlich — zum Ersten', tax: 'Steuer' },
  sw: { upfront: 'Malipo ya awali (50%)', final: 'Malipo ya mwisho (50%)', full: 'Malipo kamili', monthly: 'Huduma endelevu ya kila mwezi', kickoff: 'Kabla ya kazi kuanza', beforeWork: 'Kabla ya kazi kuanza', finalApproval: 'Idhini ya uwasilishaji wa mwisho', monthlyTrig: 'Kila mwezi — mwanzo wa mwezi', tax: 'kodi' },
}

/**
 * The Payment Schedule rows for every structure that is not an authored milestone list, so the section is always
 * present and always shows the real instalments (amounts net of tax, tax stated per row). Display only: what is
 * actually billed is still created from the structure at signing (lib/documents/post-signing.ts).
 */
export function derivedScheduleRows(input: SowContentInput): SowTableRow[] {
  if (input.paymentStructure === 'milestones') return []
  const w = (isSowLanguage(input.language) ? SCHEDULE_WORDS[input.language] : undefined) || SCHEDULE_WORDS.en
  const tax = input.tax && input.tax.rate > 0 && !input.retainer ? input.tax : null
  const cv = Number(input.contractValue)
  if (!Number.isFinite(cv) || cv <= 0) return []
  const instalments = structureInstalments(input.paymentStructure, cv)
  const label = (it: PaymentInstalment) =>
    it.title === 'Upfront payment (50%)' ? w.upfront
    : it.title === 'Final payment (50%)' ? w.final
    : it.title === 'Monthly retainer' ? w.monthly : w.full
  const trig = (it: PaymentInstalment) =>
    it.title === 'Final payment (50%)' || (it.title === 'Full payment' && input.paymentStructure === 'on_delivery') ? w.finalApproval
    : it.title === 'Monthly retainer' ? w.monthlyTrig : w.beforeWork
  return instalments.map(it => {
    const sp = splitTax(it.amount, tax)
    const taxNote = tax
      ? ` · ${tax.inclusive ? '' : '+ '}${tax.rate}% ${w.tax} (${formatMoneyText(input.currency, sp.tax)})${tax.inclusive ? ' incl.' : ''}`
      : ''
    // Amount shown is net of tax when tax is exclusive, and the gross figure when it is inclusive — the figure the contract value is expressed in.
    return { milestone: label(it), amount: String(tax && tax.inclusive ? sp.gross : sp.net), trigger: `${trig(it)}${taxNote}` }
  })
}

// ── 1. Boilerplate sections — deterministic, never asked of the model ──
//
// These three sections are never sent to the AI (see AI_SECTION_IDS
// below), so language-switching them means translating the template
// itself rather than instructing a model. Only the languages in
// SOW_LANGUAGE_NAMES are supported; an unrecognized code falls back to
// English rather than emitting a mixed-language document.

const REPRESENTED_BY: Record<string, string> = {
  en: 'represented by', es: 'representado por', fr: 'représenté par', pt: 'representado por', de: 'vertreten durch', sw: 'anayewakilishwa na',
}

const BOILERPLATE_TEMPLATES: Record<string, (agency: string, client: string, law: string) => Record<string, string>> = {
  en: (agency, client, law) => ({
    parties: `<p>This Statement of Work ("SOW") is entered into between <strong>${agency}</strong> ("Provider") and ${client} ("Client").</p>`,
    governing_law: `<p>This SOW is governed by the laws of ${law}.</p>`,
    signature: `<p>By signing below, both parties agree to the terms of this Statement of Work.</p>`,
  }),
  es: (agency, client, law) => ({
    parties: `<p>Este Acuerdo de Alcance de Trabajo se celebra entre <strong>${agency}</strong> ("la Agencia") y ${client} ("el Cliente").</p>`,
    governing_law: `<p>Este Acuerdo se rige por las leyes de ${law}.</p>`,
    signature: `<p>Al firmar a continuación, ambas partes aceptan los términos de este Acuerdo de Alcance de Trabajo.</p>`,
  }),
  fr: (agency, client, law) => ({
    parties: `<p>Le présent Énoncé des travaux est conclu entre <strong>${agency}</strong> (l'« Agence ») et ${client} (le « Client »).</p>`,
    governing_law: `<p>Le présent Accord est régi par les lois de ${law}.</p>`,
    signature: `<p>En signant ci-dessous, les deux parties acceptent les termes du présent Énoncé des travaux.</p>`,
  }),
  pt: (agency, client, law) => ({
    parties: `<p>Este Termo de Abertura de Escopo é celebrado entre <strong>${agency}</strong> ("Agência") e ${client} ("Cliente").</p>`,
    governing_law: `<p>Este Acordo é regido pelas leis de ${law}.</p>`,
    signature: `<p>Ao assinar abaixo, ambas as partes concordam com os termos deste Termo de Abertura de Escopo.</p>`,
  }),
  de: (agency, client, law) => ({
    parties: `<p>Diese Leistungsbeschreibung wird zwischen <strong>${agency}</strong> ("Agentur") und ${client} ("Kunde") geschlossen.</p>`,
    governing_law: `<p>Diese Vereinbarung unterliegt den Gesetzen von ${law}.</p>`,
    signature: `<p>Mit der nachstehenden Unterschrift stimmen beide Parteien den Bedingungen dieser Leistungsbeschreibung zu.</p>`,
  }),
  sw: (agency, client, law) => ({
    parties: `<p>Hati hii ya Wigo wa Kazi imeingiwa kati ya <strong>${agency}</strong> ("Wakala") na ${client} ("Mteja").</p>`,
    governing_law: `<p>Makubaliano haya yanaongozwa na sheria za ${law}.</p>`,
    signature: `<p>Kwa kutia sahihi hapa chini, pande zote mbili zinakubali masharti ya Hati hii ya Wigo wa Kazi.</p>`,
  }),
}

// ── 1b. Localized section titles & table headers ──────────────────────
//
// FIX (section-9 audit, 9-G7): the SOW-language feature was half-built.
// Three boilerplate sections were translated six ways, but
// SOW_SECTION_DEFS titles and SOW_TABLE_SCHEMAS column labels were
// English-only and hardcoded at the point of render — so a Spanish SOW
// printed "Parties"/"Deliverables"/"Acceptance Criteria" headings over
// Spanish body text. Titles and column headers are part of the document
// the client reads, not internal identifiers (the MARKER strings the
// parser matches on stay English — those genuinely are internal).
//
// Any language without an entry falls back to the English title, which
// is the same policy buildBoilerplateSections already applies.
export const SOW_SECTION_TITLES: Record<string, Record<string, string>> = {
  es: {
    parties: 'Partes', overview: 'Descripción del Proyecto', deliverables: 'Entregables',
    oos: 'Fuera del Alcance', timeline: 'Cronograma e Hitos', roles: 'Funciones y Responsabilidades',
    assumptions: 'Supuestos y Dependencias', payment: 'Condiciones de Pago',
    payment_schedule: 'Calendario de Pagos', revisions: 'Política de Revisiones',
    ip: 'Propiedad Intelectual', confidentiality: 'Confidencialidad', termination: 'Terminación',
    governing_law: 'Ley Aplicable', dispute: 'Resolución de Controversias', signature: 'Firmas',
  },
  fr: {
    parties: 'Parties', overview: 'Présentation du Projet', deliverables: 'Livrables',
    oos: 'Hors Périmètre', timeline: 'Calendrier et Jalons', roles: 'Rôles et Responsabilités',
    assumptions: 'Hypothèses et Dépendances', payment: 'Conditions de Paiement',
    payment_schedule: 'Échéancier de Paiement', revisions: 'Politique de Révision',
    ip: 'Propriété Intellectuelle', confidentiality: 'Confidentialité', termination: 'Résiliation',
    governing_law: 'Droit Applicable', dispute: 'Règlement des Litiges', signature: 'Signatures',
  },
  pt: {
    parties: 'Partes', overview: 'Visão Geral do Projeto', deliverables: 'Entregáveis',
    oos: 'Fora do Escopo', timeline: 'Cronograma e Marcos', roles: 'Funções e Responsabilidades',
    assumptions: 'Premissas e Dependências', payment: 'Condições de Pagamento',
    payment_schedule: 'Cronograma de Pagamentos', revisions: 'Política de Revisões',
    ip: 'Propriedade Intelectual', confidentiality: 'Confidencialidade', termination: 'Rescisão',
    governing_law: 'Lei Aplicável', dispute: 'Resolução de Conflitos', signature: 'Assinaturas',
  },
  de: {
    parties: 'Vertragsparteien', overview: 'Projektübersicht', deliverables: 'Leistungen',
    oos: 'Nicht im Leistungsumfang', timeline: 'Zeitplan und Meilensteine', roles: 'Rollen und Verantwortlichkeiten',
    assumptions: 'Annahmen und Abhängigkeiten', payment: 'Zahlungsbedingungen',
    payment_schedule: 'Zahlungsplan', revisions: 'Überarbeitungsrichtlinie',
    ip: 'Geistiges Eigentum', confidentiality: 'Vertraulichkeit', termination: 'Kündigung',
    governing_law: 'Anwendbares Recht', dispute: 'Streitbeilegung', signature: 'Unterschriften',
  },
  sw: {
    parties: 'Pande Husika', overview: 'Muhtasari wa Mradi', deliverables: 'Matokeo Yanayotarajiwa',
    oos: 'Nje ya Wigo', timeline: 'Ratiba na Hatua Muhimu', roles: 'Majukumu na Wajibu',
    assumptions: 'Mawazo na Mahitaji', payment: 'Masharti ya Malipo',
    payment_schedule: 'Ratiba ya Malipo', revisions: 'Sera ya Marekebisho',
    ip: 'Haki Miliki', confidentiality: 'Usiri', termination: 'Kusitisha',
    governing_law: 'Sheria Inayotumika', dispute: 'Utatuzi wa Migogoro', signature: 'Saini',
  },
}

/** Section title in the document's language, falling back to the English default. */
export function sectionTitle(id: string, language?: string): string {
  const def = SOW_SECTION_DEFS.find(d => d.id === id)
  const fallback = def?.title || id
  if (!language || language === 'en') return fallback
  return (isSowLanguage(language) ? SOW_SECTION_TITLES[language]?.[id] : undefined) || fallback
}

export function buildBoilerplateSections(input: SowContentInput): Record<string, string> {
  const agency = escapeHtml(input.agencyName)
  const lang   = isSowLanguage(input.language) ? input.language : 'en'
  const rep    = input.clientRepresentative && !isBlankText(input.clientRepresentative) && input.clientRepresentative.trim() !== input.clientName.trim()
    ? `, ${REPRESENTED_BY[lang] || REPRESENTED_BY.en} ${escapeHtml(input.clientRepresentative.trim())}${input.clientRepresentativeTitle && !isBlankText(input.clientRepresentativeTitle) ? `, ${escapeHtml(input.clientRepresentativeTitle.trim())}` : ''}`
    : ''
  // The legal name is the bold part; the representative clause follows it in plain text.
  const client = `<strong>${escapeHtml(input.clientName)}</strong>${rep}`
  const law    = lang === 'en' ? escapeHtml(lawWithArticle(input.governingLaw)) : escapeHtml(input.governingLaw)
  const template = BOILERPLATE_TEMPLATES[lang] || BOILERPLATE_TEMPLATES.en
  return template(agency, client, law)
}

const SECTION_MARKER = (id: string) => `<<<SECTION:${id}>>>`
const TABLE_MARKER   = (id: string) => `<<<TABLE:${id}>>>`
const TABLE_END      = '<<<ENDTABLE>>>'

function retainerTotalText(input: SowContentInput): string | null {
  const months = input.retainer?.months
  const monthly = Number(input.contractValue)
  if (!input.retainer || !months || !Number.isFinite(monthly)) return null
  return `${input.currency} ${Math.round(monthly * months * 100) / 100}`
}

/** 12500.5 -> "12,500.50" (same format ensureContractValueStated appends); non-numeric input is passed through untouched. */
function prettyAmount(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value)
}

function retainerTotalPretty(input: SowContentInput): string | null {
  const months = input.retainer?.months
  const monthly = Number(input.contractValue)
  if (!input.retainer || !months || !Number.isFinite(monthly)) return null
  return `${input.currency} ${prettyAmount(Math.round(monthly * months * 100) / 100)}`
}

function retainerPromptLines(input: SowContentInput): string {
  if (!input.retainer) return `Contract value${input.tax && input.tax.rate > 0 ? (input.tax.inclusive ? ' (tax included)' : ' (excluding tax)') : ''}: ${formatMoneyText(input.currency, input.contractValue)}`
  const total = retainerTotalText(input)
  return `Monthly retainer fee: ${formatMoneyText(input.currency, input.contractValue)} per month (this is a recurring monthly fee, NOT a one-off contract total)\n` +
    (input.retainer.months
      ? `Retainer term: ${input.retainer.months} month${input.retainer.months === 1 ? '' : 's'} (total commitment ${retainerTotalPretty(input) || total})`
      : 'Retainer term: open-ended — billed monthly until either party ends it in writing')
}

export function buildSowContentPrompt(input: SowContentInput, opts?: { emphatic?: boolean }): string {
  const markerList = AI_SECTION_IDS.map(id => SECTION_MARKER(id)).join('\n')
  const reminder = opts?.emphatic
    ? `\n\nIMPORTANT — your previous attempt did not use the required format correctly. You MUST start every prose section with its exact marker line, e.g. ${SECTION_MARKER('overview')}, and every table with its exact marker line, e.g. ${TABLE_MARKER('deliverables')}, each on its own line, with nothing else on that line, followed by ${TABLE_END} on its own line once the table's rows are done. Do not use JSON, do not use markdown code fences, do not skip any marker.`
    : ''

  const deliverableCols = SOW_TABLE_SCHEMAS.deliverables.columns.map(c => c.label).join(' | ')
  const timelineCols    = SOW_TABLE_SCHEMAS.timeline.columns.map(c => c.label).join(' | ')
  const rolesCols       = SOW_TABLE_SCHEMAS.roles.columns.map(c => c.label).join(' | ')
  // FEATURE (section-9 audit follow-up): only meaningful when the agency
  // chose the 'milestones' payment structure — every other structure
  // (50/50, 100% upfront, monthly, on delivery) already fully describes
  // its own schedule in the Payment Terms prose, and asking for an empty
  // or redundant table there would just confuse the model and the doc.
  const wantsPaymentSchedule = input.paymentStructure === 'milestones'
  const paymentScheduleTableBlock = wantsPaymentSchedule ? `

${TABLE_MARKER('payment_schedule')}
(columns: Milestone | Amount | Trigger / Due — Amount: put exactly 0 for every row, the platform calculates and fills in the real dollar amount for each milestone automatically, so do not attempt any currency math here)
row format: Milestone title | 0 | Trigger or due condition (e.g. "Upon signing", "Upon delivery of wireframes")
${TABLE_END}` : ''

  // FIX (deep audit, section 5 re-pass): the only half of the
  // SOW-language feature the model itself needs to know about — the
  // section markers, table markers, and column labels below must stay in
  // English regardless (they're parsed by exact string match in
  // parseDelimitedSections/parseTableSections), only the drafted content
  // switches language.
  const languageName = sowLanguageName(input.language || 'en')
  const languageInstruction = languageName && languageName !== 'English'
    ? `\n\nWrite ALL drafted section content and table row text in ${languageName}. Keep the section/table MARKER lines themselves exactly as specified below (in English, unchanged) — only the content after each marker is in ${languageName}. Do NOT add English glosses in parentheses (no "(Statement of Work)", "(portfolio)", "(mobile-responsive)" and the like): translate each term fully, and keep an English word only when it is a brand or product name or has no common equivalent. Refer to the two parties with ONE consistent pair of terms throughout (the same word for the agency every time, and the same word for the client), and always call this document by the same name.`
    : ''

  return `You are a professional contract drafter for a creative/digital agency.
Draft the content for a Statement of Work. Use ONLY the exact figures provided below. Never invent payment amounts, fees, rates, or revision counts.

Provider (the agency): ${input.agencyName}
Client (the contracting party): ${input.clientName}${input.clientRepresentative && !isBlankText(input.clientRepresentative) && input.clientRepresentative.trim() !== input.clientName.trim() ? `\nClient's authorised representative (signs for the Client): ${input.clientRepresentative.trim()}${input.clientRepresentativeTitle && !isBlankText(input.clientRepresentativeTitle) ? `, ${input.clientRepresentativeTitle.trim()}` : ''}` : ''}
Project: ${input.projectName}${input.projectDisc ? ` (${input.projectDisc})` : ''}
Project type: ${input.projectType}
${retainerPromptLines(input)}

Scope brief:
Objective: ${input.objective || 'Not specified'}
Deliverables:
${input.deliverables || 'As discussed'}

Out of scope (MUST be explicitly excluded):
${input.outOfScope || 'To be defined'}

Timeline: ${input.timeline || 'To be agreed'}
Payment structure: ${input.paymentLabel}
Revision rounds: ${input.revisionRounds}
Governing law: ${input.governingLaw}${taxPromptBlock(input) ? `\n${taxPromptBlock(input)}` : ''}${lateFeePromptBlock(input) ? `\n${lateFeePromptBlock(input)}` : ''}${paymentTermsPromptBlock(input) ? `\n${paymentTermsPromptBlock(input)}` : ''}

Output format — this is plain text, NOT JSON.

For each of the following ${AI_SECTION_IDS.length} prose sections, write a marker line exactly as shown, then the section's HTML content on the following line(s), then move straight to the next marker. Do not wrap anything in markdown code fences.

${markerList}

Then produce ${wantsPaymentSchedule ? 'FOUR' : 'THREE'} tables. For each, write the table marker line exactly as shown, then one row per line in the exact pipe-delimited column order given, then a line with exactly ${TABLE_END}. Do not include the column header row itself. 3-6 rows per table is typical; use your judgement based on the brief.

${TABLE_MARKER('deliverables')}
(columns: ${deliverableCols} — Owner must be exactly one of Provider, Client, or Joint)
row format: Deliverable text | Acceptance criteria text | Owner | Target date or milestone label
${TABLE_END}

${TABLE_MARKER('timeline')}
(columns: ${timelineCols})
row format: Phase name | What happens in this phase | Duration (e.g. "2 weeks", "Sep 1 - Sep 15")
${TABLE_END}

${TABLE_MARKER('roles')}
(columns: ${rolesCols} — Provider and Client must each be exactly ✓ or —, never both ✓ on the same row)
row format: Responsibility | ✓ or — | ✓ or — | Optional short note
${TABLE_END}${paymentScheduleTableBlock}

Do not add any other commentary before, between, or after sections/tables.

Rules:
- Every prose section's content must be proper HTML (use <p>, <ul>, <li>, <strong>). No raw text outside tags.
- Payment section must state exactly "${formatMoneyText(input.currency, input.contractValue)}"${input.retainer ? ' as the MONTHLY retainer fee ("per month"), never as a one-off total,' : ''} and the exact payment structure above.${input.retainer ? ' State the retainer term exactly as given above.' : ''} Do NOT invent percentages or amounts beyond what's stated.${taxPromptBlock(input) ? ' It must also say how sales tax applies, using exactly the tax rate and figures given under "Sales tax" above (including each instalment where listed), and must not state any amount that is not given.' : ''}
- Always write money as the currency code, a space, thousands separators and two decimals (for example ${formatMoneyText(input.currency, 1234.5)}) — never "${input.currency}1234.5" or "${input.currency} 1234".
- Refer to the two parties only as "Provider" (${input.agencyName}) and "Client" (${input.clientName}). Never use "Agency", "Customer", "Company" or "Vendor" as a defined term, and name the Client only by the exact legal name given above.
- Do NOT restate the parties preamble ("entered into between …") or the governing law in any section: both have their own sections. Project Overview covers the objective, a short summary of what is delivered, the timeline and the contract value (written once, in the format above) and nothing else.
- Timeline and Deliverables must agree. Use the SAME phase names in the Timeline table and in each deliverable's Target date cell, and make each deliverable's Target date exactly the end date of the Timeline phase in which it is delivered. Timeline phases must be consecutive with exact start–end dates covering the whole project period from the brief without gaps or overlaps, and each duration label must match its own dates. If the brief gives no dates, use durations only and write "To be confirmed" as the date — never invent dates.
- If a deliverable is a website or app, state in Assumptions who is responsible for hosting, domain registration and going live; do not assume the Provider does unless the brief says so.
- If the out-of-scope brief excludes something only "beyond" a basic level (for example "training beyond basic content updates"), the included basic level must itself appear as a deliverable row or an Assumptions item, naming the system it concerns. Never mention such an activity in Timeline or elsewhere unless it is listed that way.
- The Revision Policy must say that work beyond the included revision rounds, or outside the listed deliverables, requires a written change order signed by both parties before it begins.
- Out of scope section must list every item from the out-of-scope brief as explicit exclusions. Be specific.
- Revision policy must reference exactly ${input.revisionRounds} revision round(s).
- Deliverables table rows must cover every item in the deliverables brief above — one row per deliverable, not grouped.
- Roles table must reflect that ${input.agencyName} is the Provider and ${input.clientName} is the Client.
- Write with professional, authoritative language appropriate for a legal document.
- Never add a late fee, late-fee rate or revision fee unless it is explicitly provided above.
- Never write a limitation of liability, liability cap, indemnity, warranty or damages clause. If the agency wants one it is added separately; any you write would contradict it.
- Whenever you write a calendar date, include the year and use this style: ${input.dateStyle === 'us' ? '"June 16, 2026" (month day, year)' : '"16 June 2026" (day month year)'}. Never print a date without the year and never mix the two styles.
- The Dispute Resolution section covers only the escalation steps (negotiation, mediation, courts). Do NOT restate the governing-law clause there: it has its own Governing Law section. The one exception is the courts step, which must say proceedings are brought in the competent courts of the jurisdiction given under "Governing law" above, naming that jurisdiction exactly as given — never a city, county, district or any other place, and never a different jurisdiction.${standardsPromptBlock(input.standards)}${wantsPaymentSchedule ? '\n- Payment Schedule table: propose sensible milestone titles and trigger conditions based on the deliverables/timeline above. Amount must be exactly 0 on every row — never write a dollar figure or percentage there.' : ''}${languageInstruction}${reminder}`
}

// ── 3. Parsers — tolerant of anything except the markers themselves ────

export class SowContentParseError extends Error {
  constructor(public missingOrEmpty: string[]) {
    super(`Missing or empty sections: ${missingOrEmpty.join(', ')}`)
  }
}

// FIX (SOW lifecycle independent pass 13, B1): the model's output is prose sections first, then tables. Only a table
// block that carried its closing <<<ENDTABLE>>> was cut out of the prose, and everything after the last section marker
// belonged to the last prose section (Dispute Resolution). So a reply cut off at max_tokens inside a table, a model that
// forgot the final ENDTABLE, a trailing code fence, or a closing "let me know if you'd like changes" line all became
// literal contract text in the client-facing Dispute Resolution section ("&lt;&lt;&gt;&gt; Kickoff | 0 | ...").
// A table now ends at its ENDTABLE or at the next marker; a section's text ends where its first table starts; stray
// code-fence lines and ENDTABLE markers are dropped.
const TABLE_BLOCK_RE = /<<<TABLE:[a-z_]+>>>[\s\S]*?(?:<<<ENDTABLE>>>|(?=<<<TABLE:|<<<SECTION:)|$)/g
const CUT = '\u0000CUT\u0000'

export function parseDelimitedSections(raw: string): Record<string, string> {
  // Split on marker lines, keeping the captured id. This succeeds even if
  // the model added a stray preamble sentence or wrapped the whole thing
  // in a code fence — we only care that the markers themselves are intact,
  // not that the surrounding text is "clean". Table blocks are cut out
  // first so their pipe-delimited rows can never be mistaken for prose.
  const withoutTables = raw
    .replace(/^[ \t]*```[a-z]*[ \t]*$/gim, '')
    .replace(TABLE_BLOCK_RE, CUT)
    .replace(/<<<ENDTABLE>>>/g, '')
  const parts = withoutTables.split(/<<<SECTION:([a-z_]+)>>>/)
  const sections: Record<string, string> = {}
  // parts = [preamble, id1, content1, id2, content2, ...]
  // FIX (section-9 audit, 9-B7): this accepted ANY `[a-z_]+` id, and
  // app/api/sow/generate/route.ts then does `{ ...boilerplate,
  // ...aiSections }` — so a model that emitted `<<<SECTION:governing_law>>>`
  // would silently overwrite the deterministic, server-owned boilerplate
  // this file's own header promises is "never asked of the model". The
  // AI is asked for exactly AI_SECTION_IDS; accept exactly that and
  // discard anything else.
  const allowed = new Set(AI_SECTION_IDS)
  for (let i = 1; i < parts.length; i += 2) {
    const id      = parts[i]?.trim()
    const content = (parts[i + 1] || '').split(CUT)[0].trim()
    if (id && allowed.has(id)) sections[id] = content
  }

  const missingOrEmpty = AI_SECTION_IDS.filter(id => !sections[id] || sections[id].length < 10)
  if (missingOrEmpty.length > 0) throw new SowContentParseError(missingOrEmpty)

  return sections
}

/**
 * Parses the three TABLE blocks into row objects keyed per
 * SOW_TABLE_SCHEMAS. Deliberately tolerant per-row: a malformed row
 * (wrong column count, empty) is dropped rather than failing the whole
 * table, since a table with 4 good rows and 1 dropped row is still a
 * usable, professional document. Unlike the prose parser this never
 * throws — a table that comes back empty is handled by the caller
 * falling back to buildFallbackTables() for that section.
 */
// FIX (section-9 audit, 9-B8): the old normalizer was
// `options.find(o => value.toLowerCase().startsWith(o.toLowerCase()[0]))`
// — a first-character match against the option itself. For the roles
// table (options ['✓', '—']) no natural model output ever starts with
// '✓' or '—', so "Yes" AND "No" both fell through to the last option,
// '—'. Every responsibility came back assigned to nobody. For the
// deliverables Owner column (['Provider','Client','Joint']) "Agency" —
// the obvious word a model reaches for — matched nothing and landed on
// 'Joint'. Match on what models actually write instead.
const AFFIRMATIVE = ['✓', '✔', 'x', 'yes', 'y', 'true', '1', 'si', 'sí', 'oui', 'ja', 'ndiyo', 'sim']
const NEGATIVE    = ['—', '-', '–', 'no', 'n', 'false', '0', 'non', 'nein', 'hapana', 'nao', 'não', 'n/a', 'na', '']

export function normalizeEnumCell(value: string, options: string[]): string {
  const v = value.trim().toLowerCase()

  // Tick/dash columns (roles table): decide by meaning, not first letter.
  if (options.length === 2 && options[0] === '✓') {
    if (AFFIRMATIVE.includes(v)) return options[0]
    if (NEGATIVE.includes(v))    return options[1]
    // Anything else non-empty reads as "this party is involved".
    return v ? options[0] : options[1]
  }

  // Word columns (Owner): exact, then prefix, then a small synonym map.
  // An empty cell is "unspecified": same default (the last option) the editor, blankRow and sanitizeTableRows use.
  // (SOW lifecycle pass 17, B1: ''.startsWith-style prefix matching used to resolve it to the FIRST option, Provider.)
  if (!v) return options[options.length - 1]
  const exact = options.find(o => o.toLowerCase() === v)
  if (exact) return exact
  const prefix = options.find(o => v.startsWith(o.toLowerCase()) || o.toLowerCase().startsWith(v))
  if (prefix) return prefix
  // FIX (SOW lifecycle independent pass 19, B1): the synonym map was English-only. In an es/fr/pt/de/sw SOW a
  // model that ignores "exactly Provider/Client/Joint" and localizes the value ("Proveedor", "Prestataire",
  // "Auftragnehmer", "Mtoa huduma") matched nothing and fell through to the LAST option, Joint, silently turning a
  // provider-owned deliverable into a shared one in the contract. Match accent-folded, localized words too.
  const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
  const SYNONYMS: Record<string, string> = {
    agency: 'Provider', vendor: 'Provider', supplier: 'Provider', contractor: 'Provider',
    us: 'Provider', we: 'Provider', consultant: 'Provider', freelancer: 'Provider',
    customer: 'Client', them: 'Client', 'client team': 'Client',
    both: 'Joint', shared: 'Joint', mutual: 'Joint', together: 'Joint',
    // es
    proveedor: 'Provider', agencia: 'Provider', consultor: 'Provider', nosotros: 'Provider', contratista: 'Provider',
    cliente: 'Client', ambos: 'Joint', conjunto: 'Joint', conjunta: 'Joint', compartido: 'Joint', mutuo: 'Joint', mixto: 'Joint',
    // fr
    prestataire: 'Provider', fournisseur: 'Provider', agence: 'Provider', nous: 'Provider',
    'les deux': 'Joint', conjoint: 'Joint', conjointe: 'Joint', partage: 'Joint', ensemble: 'Joint',
    // pt
    prestador: 'Provider', fornecedor: 'Provider', nos: 'Provider', contratado: 'Provider',
    compartilhado: 'Joint', conjuntos: 'Joint',
    // de
    anbieter: 'Provider', auftragnehmer: 'Provider', agentur: 'Provider', dienstleister: 'Provider', wir: 'Provider',
    kunde: 'Client', auftraggeber: 'Client', beide: 'Joint', gemeinsam: 'Joint', zusammen: 'Joint',
    // sw
    'mtoa huduma': 'Provider', mtoa: 'Provider', wakala: 'Provider', sisi: 'Provider', mkandarasi: 'Provider',
    mteja: 'Client', pamoja: 'Joint', wote: 'Joint', 'kwa pamoja': 'Joint',
  }
  const mapped = SYNONYMS[v] ?? SYNONYMS[fold(v)]
  if (mapped && options.includes(mapped)) return mapped
  // Localized value followed by detail, e.g. "Proveedor (equipo de diseño)" / "Client - approval".
  const lead = fold(v).split(/[\s(,;:\/-]+/).filter(Boolean)[0]
  const leadMapped = lead ? SYNONYMS[lead] : undefined
  if (leadMapped && options.includes(leadMapped)) return leadMapped

  return options[options.length - 1]
}

export function parseTableSections(raw: string): Record<SowTableSectionId, SowTableRow[]> {
  const result: Record<SowTableSectionId, SowTableRow[]> = { deliverables: [], timeline: [], roles: [], payment_schedule: [] }

  for (const id of TABLE_IDS) {
    // FIX (SOW lifecycle independent pass 13, B1): a table ends at its ENDTABLE or, when the model forgot it, at the next
    // marker. One that runs to the very end of the output may be cut off mid-row, so it is not used (the caller falls back
    // to the deterministic table for it) rather than trusting a half-written last row.
    const re = new RegExp(`<<<TABLE:${id}>>>([\\s\\S]*?)(?:<<<ENDTABLE>>>|(?=<<<TABLE:|<<<SECTION:))`)
    const match = raw.match(re)
    if (!match) continue

    const schema = SOW_TABLE_SCHEMAS[id]
    const lines = match[1].split('\n').map(l => l.trim()).filter(Boolean)
      // Skip a stray column-header / format echo if the model repeated it despite instructions.
      // FIX (SOW lifecycle independent pass 12, B5): this dropped EVERY line starting with "(" — so a real
      // deliverable such as "(Optional) Brand book | Signed off | Provider | Week 4" vanished from the contract
      // silently (the table was not empty, so no fallback fired). Only a line that is clearly the prompt's own
      // "(columns: ...)" echo, or one wholly wrapped in a single pair of parentheses, is skipped.
      .filter(l => !(/^\(\s*columns?\b/i.test(l) || /^\([^()]*\)$/.test(l)))
      // FIX (SOW lifecycle independent pass 15, B1): markdown-style output. Strip one leading/trailing pipe so a row
      // written "| a | b | c |" does not gain empty edge cells that shift every column, and drop separator lines
      // ("|---|---|"), which were kept as rows of dashes.
      .map(l => l.replace(/^\|/, '').replace(/\|$/, '').trim())
      .filter(l => l && !/^[\s|:\-]+$/.test(l))

    // A repeated column-header row (the prompt says not to include it) is not data: its cells are the column labels.
    const headerLabels = schema.columns.map(c => c.label.toLowerCase())
    const rows: SowTableRow[] = []
    for (const line of lines) {
      const cells = line.split('|').map(c => c.trim())
      if (cells.length >= 2 && cells.every((c, i) => c.toLowerCase() === headerLabels[i] || (i >= headerLabels.length && !c))) continue
      // FIX (SOW lifecycle independent pass 2, B6): a row with fewer cells than columns was discarded outright.
      // The prompt itself calls the Roles "note" cell optional ("Responsibility | ✓ or — | ✓ or — | Optional
      // short note"), so a model that leaves the note off — without the trailing "|" — had every such row
      // thrown away, and when that was every row the whole table silently fell back to generic boilerplate.
      // A row that is only missing TRAILING free-text cells (never an enum column, never the first column) is
      // now padded with blanks. Anything shorter than that is still dropped, since we cannot tell which
      // column an omitted middle cell belonged to.
      if (cells.length < schema.columns.length) {
        const missing = schema.columns.slice(cells.length)
        const onlyTrailingFreeText = cells.length >= 2 && missing.every(col => !col.options)
        if (!onlyTrailingFreeText) continue
      }
      // FIX (SOW lifecycle independent pass 12, B5): cells beyond the column count (a literal "|" inside the last
      // free-text cell) were silently discarded. They are folded back into the last column instead of lost.
      if (cells.length > schema.columns.length) {
        const keep = schema.columns.length - 1
        cells.splice(keep, cells.length - keep, cells.slice(keep).filter(Boolean).join(' | '))
      }
      const row: SowTableRow = {}
      schema.columns.forEach((col, i) => {
        let value = sanitizePlainText(cells[i] || '')
        if (col.options && !col.options.includes(value)) {
          value = normalizeEnumCell(value, col.options)
        }
        row[col.key] = value
      })
      rows.push(row)
    }
    result[id] = rows
  }

  return result
}

// ── 4. Deterministic fallback — guaranteed to succeed, no AI involved ──
// Used only if every AI attempt fails to parse. Plainer language than the
// AI-drafted version, but a complete, legally-structured, usable SOW —
// the user is never blocked from generating a document.

// FIX (section-9 audit, 9-G7, third and last piece): the deterministic
// fallback was English-only. It fires precisely when all three AI
// attempts fail — so the worst-case document, for a workspace that chose
// Spanish or Swahili, was an entirely English contract body with a
// translated parties clause and governing-law line bolted on. That's the
// mixed-language output buildBoilerplateSections' own comment says it
// exists to avoid. Same fallback-to-English policy for unknown codes.
interface FallbackStrings {
  overviewDefault: (agency: string, type: string, client: string) => string
  oosIntro:   string
  oosNone:    string
  assumptions: string
  paymentTotal: string
  paymentStructure: string
  // B1 (pass 10): retainer wording — the stored value is a monthly fee, not a contract total.
  paymentMonthly: string
  perMonth: string
  paymentTerm: (months: number, total: string) => string
  paymentOpenEnded: string
  revisions:  (rounds: number) => string
  ip:         (agency: string) => string
  confidentiality: string
  termination: string
  dispute:    string
}

const FALLBACK_STRINGS: Record<string, FallbackStrings> = {
  en: {
    overviewDefault: (a, t, c) => `${a} will deliver a ${t} project for ${c} as described in the accompanying brief.`,
    oosIntro: 'The following are explicitly excluded from this engagement:',
    oosNone: 'Any work not explicitly listed under Deliverables above is considered out of scope and will require a separate Change Order.',
    assumptions: 'This Statement of Work assumes timely feedback, approvals, and provision of any required materials or access from the Client. Delays in Client responsiveness may affect the timeline above.',
    paymentTotal: 'Total contract value',
    paymentStructure: 'Payment structure',
    paymentMonthly: 'Monthly retainer fee',
    perMonth: 'per month',
    paymentTerm: (m, t) => `Term: ${m} month${m === 1 ? '' : 's'} (total commitment ${t})`,
    paymentOpenEnded: 'Term: open-ended, billed monthly until either party ends it in writing',
    revisions: r => `This engagement includes ${r} round${r === 1 ? '' : 's'} of revisions per deliverable. Additional revision rounds beyond this may be billed separately or handled via a Change Order.`,
    ip: a => `Upon receipt of full payment, all final deliverables become the property of the Client. ${a} retains the right to display the work in its portfolio unless otherwise agreed in writing.`,
    confidentiality: 'Both parties agree to keep confidential any proprietary or non-public information shared during the course of this engagement.',
    termination: 'Either party may terminate this engagement with written notice. Client will be billed for all work completed up to the date of termination.',
    dispute: 'Any disputes arising from this Statement of Work will first be addressed through good-faith negotiation between the parties before pursuing formal resolution under the governing law stated below.',
  },
  es: {
    overviewDefault: (a, t, c) => `${a} entregará un proyecto de ${t} para ${c} según lo descrito en el resumen adjunto.`,
    oosIntro: 'Los siguientes elementos quedan expresamente excluidos de este encargo:',
    oosNone: 'Cualquier trabajo no incluido expresamente en los Entregables anteriores se considera fuera del alcance y requerirá una Orden de Cambio independiente.',
    assumptions: 'Este Acuerdo de Alcance de Trabajo presupone comentarios, aprobaciones y la entrega de los materiales o accesos necesarios por parte del Cliente de forma oportuna. Los retrasos en la respuesta del Cliente pueden afectar al cronograma anterior.',
    paymentTotal: 'Valor total del contrato',
    paymentStructure: 'Estructura de pago',
    paymentMonthly: 'Cuota mensual de la iguala',
    perMonth: 'al mes',
    paymentTerm: (m, t) => `Plazo: ${m} mes${m === 1 ? '' : 'es'} (compromiso total ${t})`,
    paymentOpenEnded: 'Plazo: indefinido, facturado mensualmente hasta que cualquiera de las partes lo termine por escrito',
    revisions: r => `Este encargo incluye ${r} ronda${r === 1 ? '' : 's'} de revisiones por entregable. Las rondas adicionales podrán facturarse por separado o gestionarse mediante una Orden de Cambio.`,
    ip: a => `Tras el pago íntegro, todos los entregables finales pasan a ser propiedad del Cliente. ${a} conserva el derecho a mostrar el trabajo en su portafolio salvo acuerdo escrito en contrario.`,
    confidentiality: 'Ambas partes se comprometen a mantener la confidencialidad de toda información propietaria o no pública compartida durante este encargo.',
    termination: 'Cualquiera de las partes podrá resolver este encargo mediante notificación por escrito. Se facturará al Cliente todo el trabajo realizado hasta la fecha de resolución.',
    dispute: 'Toda controversia derivada de este Acuerdo de Alcance de Trabajo se abordará en primer lugar mediante negociación de buena fe entre las partes antes de acudir a la resolución formal conforme a la ley aplicable indicada a continuación.',
  },
  fr: {
    overviewDefault: (a, t, c) => `${a} réalisera un projet de type ${t} pour ${c}, tel que décrit dans le brief joint.`,
    oosIntro: 'Les éléments suivants sont expressément exclus de la présente mission :',
    oosNone: 'Tout travail non expressément listé dans les Livrables ci-dessus est considéré hors périmètre et nécessitera un Avenant distinct.',
    assumptions: 'Le présent Énoncé des travaux suppose des retours, validations et la fourniture des matériaux ou accès nécessaires par le Client dans des délais raisonnables. Tout retard du Client peut affecter le calendrier ci-dessus.',
    paymentTotal: 'Valeur totale du contrat',
    paymentStructure: 'Modalités de paiement',
    paymentMonthly: 'Honoraires mensuels du forfait récurrent',
    perMonth: 'par mois',
    paymentTerm: (m, t) => `Durée : ${m} mois (engagement total ${t})`,
    paymentOpenEnded: 'Durée : indéterminée, facturée mensuellement jusqu\'à résiliation écrite par l\'une des parties',
    revisions: r => `La présente mission comprend ${r} série${r === 1 ? '' : 's'} de révisions par livrable. Toute série supplémentaire pourra être facturée séparément ou traitée par Avenant.`,
    ip: a => `Après paiement intégral, l'ensemble des livrables finaux devient la propriété du Client. ${a} conserve le droit de présenter le travail dans son portfolio, sauf accord écrit contraire.`,
    confidentiality: 'Les deux parties s\'engagent à préserver la confidentialité de toute information propriétaire ou non publique échangée dans le cadre de la présente mission.',
    termination: 'Chaque partie peut mettre fin à la présente mission par notification écrite. Le Client sera facturé pour tous les travaux réalisés jusqu\'à la date de résiliation.',
    dispute: 'Tout litige découlant du présent Énoncé des travaux sera d\'abord traité par une négociation de bonne foi entre les parties avant toute résolution formelle au titre du droit applicable indiqué ci-dessous.',
  },
  pt: {
    overviewDefault: (a, t, c) => `A ${a} entregará um projeto de ${t} para ${c}, conforme descrito no briefing anexo.`,
    oosIntro: 'Os itens a seguir estão expressamente excluídos deste trabalho:',
    oosNone: 'Qualquer trabalho não listado expressamente nos Entregáveis acima é considerado fora do escopo e exigirá uma Ordem de Mudança separada.',
    assumptions: 'Este Termo de Abertura de Escopo pressupõe retorno, aprovações e o fornecimento de quaisquer materiais ou acessos necessários pelo Cliente em tempo hábil. Atrasos na resposta do Cliente podem afetar o cronograma acima.',
    paymentTotal: 'Valor total do contrato',
    paymentStructure: 'Estrutura de pagamento',
    paymentMonthly: 'Valor mensal do retainer',
    perMonth: 'por mês',
    paymentTerm: (m, t) => `Prazo: ${m} ${m === 1 ? 'mês' : 'meses'} (compromisso total ${t})`,
    paymentOpenEnded: 'Prazo: indeterminado, faturado mensalmente até ser encerrado por escrito por qualquer das partes',
    revisions: r => `Este trabalho inclui ${r} rodada${r === 1 ? '' : 's'} de revisões por entregável. Rodadas adicionais poderão ser cobradas separadamente ou tratadas por Ordem de Mudança.`,
    ip: a => `Mediante o pagamento integral, todos os entregáveis finais tornam-se propriedade do Cliente. A ${a} mantém o direito de exibir o trabalho em seu portfólio, salvo acordo escrito em contrário.`,
    confidentiality: 'Ambas as partes concordam em manter sigilo sobre qualquer informação proprietária ou não pública compartilhada durante este trabalho.',
    termination: 'Qualquer das partes poderá rescindir este trabalho mediante aviso por escrito. O Cliente será cobrado por todo o trabalho concluído até a data da rescisão.',
    dispute: 'Quaisquer controvérsias decorrentes deste Termo de Abertura de Escopo serão primeiro tratadas por negociação de boa-fé entre as partes, antes de qualquer resolução formal sob a lei aplicável indicada abaixo.',
  },
  de: {
    overviewDefault: (a, t, c) => `${a} erbringt für ${c} ein ${t}-Projekt gemäß dem beigefügten Briefing.`,
    oosIntro: 'Die folgenden Punkte sind ausdrücklich nicht Gegenstand dieses Auftrags:',
    oosNone: 'Alle Leistungen, die oben nicht ausdrücklich unter Leistungen aufgeführt sind, gelten als nicht im Leistungsumfang enthalten und erfordern einen gesonderten Änderungsauftrag.',
    assumptions: 'Diese Leistungsbeschreibung setzt zeitnahe Rückmeldungen, Freigaben sowie die Bereitstellung erforderlicher Materialien oder Zugänge durch den Kunden voraus. Verzögerungen seitens des Kunden können den obigen Zeitplan beeinflussen.',
    paymentTotal: 'Gesamtauftragswert',
    paymentStructure: 'Zahlungsstruktur',
    paymentMonthly: 'Monatliche Retainer-Gebühr',
    perMonth: 'pro Monat',
    paymentTerm: (m, t) => `Laufzeit: ${m} Monat${m === 1 ? '' : 'e'} (Gesamtverpflichtung ${t})`,
    paymentOpenEnded: 'Laufzeit: unbefristet, monatlich abgerechnet, bis eine Partei schriftlich kündigt',
    revisions: r => `Dieser Auftrag umfasst ${r} Überarbeitungsrunde${r === 1 ? '' : 'n'} je Leistung. Darüber hinausgehende Runden können gesondert berechnet oder über einen Änderungsauftrag abgewickelt werden.`,
    ip: a => `Nach vollständiger Zahlung gehen alle finalen Leistungen in das Eigentum des Kunden über. ${a} behält das Recht, die Arbeit im eigenen Portfolio zu zeigen, sofern nicht schriftlich anders vereinbart.`,
    confidentiality: 'Beide Parteien verpflichten sich, alle im Rahmen dieses Auftrags ausgetauschten vertraulichen oder nicht öffentlichen Informationen geheim zu halten.',
    termination: 'Jede Partei kann diesen Auftrag schriftlich kündigen. Dem Kunden werden alle bis zum Kündigungsdatum erbrachten Leistungen in Rechnung gestellt.',
    dispute: 'Streitigkeiten aus dieser Leistungsbeschreibung werden zunächst durch Verhandlungen nach Treu und Glauben zwischen den Parteien behandelt, bevor eine förmliche Beilegung nach dem unten genannten anwendbaren Recht angestrebt wird.',
  },
  sw: {
    overviewDefault: (a, t, c) => `${a} itatekeleza mradi wa ${t} kwa ${c} kama ilivyoelezwa katika muhtasari ulioambatanishwa.`,
    oosIntro: 'Yafuatayo hayajumuishwi katika kazi hii:',
    oosNone: 'Kazi yoyote ambayo haijaorodheshwa wazi chini ya Matokeo Yanayotarajiwa hapo juu inachukuliwa kuwa nje ya wigo na itahitaji Agizo la Mabadiliko tofauti.',
    assumptions: 'Hati hii ya Wigo wa Kazi inachukulia kwamba Mteja atatoa maoni, idhini, na vifaa au ufikiaji unaohitajika kwa wakati. Ucheleweshaji wa Mteja unaweza kuathiri ratiba iliyo hapo juu.',
    paymentTotal: 'Thamani jumla ya mkataba',
    paymentStructure: 'Mpangilio wa malipo',
    paymentMonthly: 'Ada ya kila mwezi ya huduma endelevu',
    perMonth: 'kwa mwezi',
    paymentTerm: (m, t) => `Muda: miezi ${m} (jumla ya ahadi ${t})`,
    paymentOpenEnded: 'Muda: usio na kikomo, hutozwa kila mwezi hadi upande wowote usitishe kwa maandishi',
    revisions: r => `Kazi hii inajumuisha mzunguko ${r} wa marekebisho kwa kila kinachotolewa. Mizunguko ya ziada inaweza kutozwa kando au kushughulikiwa kupitia Agizo la Mabadiliko.`,
    ip: a => `Baada ya malipo kamili, matokeo yote ya mwisho yatakuwa mali ya Mteja. ${a} inabaki na haki ya kuonyesha kazi hiyo katika kumbukumbu zake za kazi isipokuwa kama imekubaliwa vinginevyo kwa maandishi.`,
    confidentiality: 'Pande zote mbili zinakubali kutunza siri taarifa zozote za kimiliki au zisizo za umma zilizoshirikiwa wakati wa kazi hii.',
    termination: 'Upande wowote unaweza kusitisha kazi hii kwa taarifa ya maandishi. Mteja atatozwa kwa kazi yote iliyokamilika hadi tarehe ya kusitishwa.',
    dispute: 'Mgogoro wowote unaotokana na Hati hii ya Wigo wa Kazi utashughulikiwa kwanza kwa majadiliano ya nia njema kati ya pande husika kabla ya kufuata utatuzi rasmi chini ya sheria inayotumika iliyotajwa hapa chini.',
  },
}

// Payment-structure wording for the fallback (non-AI) Payment Terms section, per drafting language.
// The English labels live in app/api/sow/generate/route.ts and also feed the AI prompt; the fallback prints
// the label directly into the document, so it must not be English inside a non-English SOW.
const PAYMENT_STRUCTURE_WORDS: Record<string, Record<string, string>> = {
  es: { '50_50': '50% al inicio, 50% a la entrega final', '100_upfront': '100% antes de comenzar el trabajo', milestones: 'Pagadero por hitos, según se define a continuación', monthly: 'Facturación mensual por adelantado', on_delivery: '100% a la entrega final y aprobación' },
  fr: { '50_50': '50 % à la commande, 50 % à la livraison finale', '100_upfront': '100 % avant le début des travaux', milestones: 'Payable par jalons, comme défini ci-dessous', monthly: 'Facturé mensuellement à l\'avance', on_delivery: '100 % à la livraison finale et à l\'approbation' },
  pt: { '50_50': '50% no início, 50% na entrega final', '100_upfront': '100% antes do início do trabalho', milestones: 'Pagável por marcos, conforme definido abaixo', monthly: 'Faturado mensalmente de forma antecipada', on_delivery: '100% na entrega final e aprovação' },
  de: { '50_50': '50 % bei Beauftragung, 50 % bei Endabnahme', '100_upfront': '100 % vor Arbeitsbeginn', milestones: 'Zahlbar in Meilensteinen, wie unten festgelegt', monthly: 'Monatlich im Voraus abgerechnet', on_delivery: '100 % bei Endabnahme und Freigabe' },
  sw: { '50_50': '50% mapema, 50% wakati wa uwasilishaji wa mwisho', '100_upfront': '100% kabla ya kazi kuanza', milestones: 'Italipwa kwa hatua muhimu kama ilivyoainishwa hapa chini', monthly: 'Hutozwa kila mwezi mapema', on_delivery: '100% wakati wa uwasilishaji wa mwisho na idhini' },
}
function localizedPaymentLabel(input: { language?: string; paymentStructure: string; paymentLabel: string }): string {
  if (!isSowLanguage(input.language) || input.language === 'en') return input.paymentLabel
  return PAYMENT_STRUCTURE_WORDS[input.language]?.[input.paymentStructure] ?? input.paymentLabel
}

export function buildFallbackSections(input: SowContentInput): Record<string, string> {
  const t = (isSowLanguage(input.language) ? FALLBACK_STRINGS[input.language] : undefined) || FALLBACK_STRINGS.en

  const outOfScopeItems = (input.outOfScope || '').split('\n')
    // FIX (SOW lifecycle independent pass 18, B2): strip the bullet marker BEFORE dropping empty lines — a bare "-" line
    // used to survive the filter and print as an empty <li> (an empty bullet on the PDF). Deliverables and Timeline
    // already filter after stripping.
    .map(l => l.trim().replace(/^[-*]\s*/, '').trim())
    .filter(l => !isBlankText(l))
    .map(l => `<li>${escapeHtml(l)}</li>`).join('')

  return {
    overview: `<p>${escapeHtml((input.objective || '').trim() ||
      t.overviewDefault(input.agencyName, input.projectType, input.clientName))}</p>`,
    oos: outOfScopeItems
      ? `<p>${t.oosIntro}</p><ul>${outOfScopeItems}</ul>`
      : `<p>${t.oosNone}</p>`,
    assumptions: `<p>${t.assumptions}</p>`,
    // FIX (SOW lifecycle independent pass 22, B5): the amount was String(contractValue) — "USD 12500.5" — while the AI path's
    // ensureContractValueStated prints "USD 12,500.50". Same formatting here so a fallback document reads like any other.
    payment: input.retainer
      ? `<p>${t.paymentMonthly}: <strong>${escapeHtml(String(input.currency))} ${escapeHtml(prettyAmount(input.contractValue))}</strong> ${t.perMonth}. ${
          input.retainer.months ? t.paymentTerm(input.retainer.months, escapeHtml(retainerTotalPretty(input) || '')) : t.paymentOpenEnded
        }. ${t.paymentStructure}: ${escapeHtml(localizedPaymentLabel(input))}.</p>`
      : `<p>${t.paymentTotal}: <strong>${escapeHtml(String(input.currency))} ${escapeHtml(prettyAmount(input.contractValue))}</strong>. ${t.paymentStructure}: ${escapeHtml(localizedPaymentLabel(input))}.</p>${!input.language || input.language === 'en' ? taxSentenceHtml(input) + lateFeeSentenceHtml(input) : ''}`,
    revisions: `<p>${t.revisions(input.revisionRounds)}</p>`,
    ip: `<p>${t.ip(escapeHtml(input.agencyName))}</p>`,
    confidentiality: `<p>${t.confidentiality}</p>`,
    termination: `<p>${t.termination}</p>`,
    dispute: `<p>${t.dispute}</p>`,
  }
}

// Static cell text used by buildFallbackTables — same 9-G7 reasoning as
// FALLBACK_STRINGS above: these land in the client-facing tables.
const FALLBACK_TABLE_STRINGS: Record<string, {
  tbc: string; approvedByClient: string; phase: string; genericDeliverable: string; delivery: string
  roleDelivery: string; roleFeedback: string; roleMaterials: string; rolePayment: string
  msKickoff: string; msMid: string; msFinal: string
  trigSigning: string; trigMid: string; trigFinal: string
}> = {
  en: { tbc: 'To be confirmed', approvedByClient: 'Reviewed and approved by Client', phase: 'Phase', genericDeliverable: 'Project deliverable as discussed with the Provider', delivery: 'Delivery',
        roleDelivery: 'Delivery of contracted work', roleFeedback: 'Timely feedback and approvals', roleMaterials: 'Provision of required materials and access', rolePayment: 'Payment per the schedule below',
        msKickoff: 'Kickoff & Discovery', msMid: 'Mid-project delivery', msFinal: 'Final delivery & sign-off',
        trigSigning: 'Upon signing', trigMid: 'Upon delivery of key deliverables', trigFinal: 'Upon final acceptance' },
  es: { tbc: 'Por confirmar', approvedByClient: 'Revisado y aprobado por el Cliente', phase: 'Fase', genericDeliverable: 'Entregable del proyecto según lo acordado con la Agencia', delivery: 'Entrega',
        roleDelivery: 'Ejecución del trabajo contratado', roleFeedback: 'Comentarios y aprobaciones puntuales', roleMaterials: 'Entrega de materiales y accesos necesarios', rolePayment: 'Pago según el calendario siguiente',
        msKickoff: 'Inicio y descubrimiento', msMid: 'Entrega intermedia', msFinal: 'Entrega final y aprobación',
        trigSigning: 'A la firma', trigMid: 'A la entrega de los elementos clave', trigFinal: 'A la aceptación final' },
  fr: { tbc: 'À confirmer', approvedByClient: 'Revu et approuvé par le Client', phase: 'Phase', genericDeliverable: 'Livrable du projet tel que convenu avec l\'Agence', delivery: 'Livraison',
        roleDelivery: 'Réalisation des travaux contractés', roleFeedback: 'Retours et validations dans les délais', roleMaterials: 'Fourniture des matériaux et accès nécessaires', rolePayment: 'Paiement selon l\'échéancier ci-dessous',
        msKickoff: 'Lancement et cadrage', msMid: 'Livraison intermédiaire', msFinal: 'Livraison finale et validation',
        trigSigning: 'À la signature', trigMid: 'À la livraison des éléments clés', trigFinal: 'À l\'acceptation finale' },
  pt: { tbc: 'A confirmar', approvedByClient: 'Revisado e aprovado pelo Cliente', phase: 'Fase', genericDeliverable: 'Entregável do projeto conforme acordado com a Agência', delivery: 'Entrega',
        roleDelivery: 'Execução do trabalho contratado', roleFeedback: 'Retorno e aprovações em tempo hábil', roleMaterials: 'Fornecimento de materiais e acessos necessários', rolePayment: 'Pagamento conforme o cronograma abaixo',
        msKickoff: 'Início e descoberta', msMid: 'Entrega intermediária', msFinal: 'Entrega final e aprovação',
        trigSigning: 'Na assinatura', trigMid: 'Na entrega dos principais itens', trigFinal: 'Na aceitação final' },
  de: { tbc: 'Wird bestätigt', approvedByClient: 'Vom Kunden geprüft und freigegeben', phase: 'Phase', genericDeliverable: 'Projektleistung wie mit der Agentur besprochen', delivery: 'Lieferung',
        roleDelivery: 'Erbringung der beauftragten Leistungen', roleFeedback: 'Zeitnahe Rückmeldungen und Freigaben', roleMaterials: 'Bereitstellung erforderlicher Materialien und Zugänge', rolePayment: 'Zahlung gemäß nachstehendem Plan',
        msKickoff: 'Kickoff & Analyse', msMid: 'Zwischenlieferung', msFinal: 'Endlieferung & Abnahme',
        trigSigning: 'Bei Unterzeichnung', trigMid: 'Bei Lieferung der wesentlichen Leistungen', trigFinal: 'Bei finaler Abnahme' },
  sw: { tbc: 'Itathibitishwa', approvedByClient: 'Imekaguliwa na kuidhinishwa na Mteja', phase: 'Awamu', genericDeliverable: 'Kinachotolewa katika mradi kama ilivyokubaliwa na Wakala', delivery: 'Uwasilishaji',
        roleDelivery: 'Utekelezaji wa kazi iliyokubaliwa', roleFeedback: 'Maoni na idhini kwa wakati', roleMaterials: 'Kutoa vifaa na ufikiaji unaohitajika', rolePayment: 'Malipo kulingana na ratiba iliyo hapa chini',
        msKickoff: 'Uzinduzi na Utafiti', msMid: 'Uwasilishaji wa katikati', msFinal: 'Uwasilishaji wa mwisho na idhini',
        trigSigning: 'Wakati wa kutia saini', trigMid: 'Baada ya kuwasilisha vitu muhimu', trigFinal: 'Baada ya kukubalika kwa mwisho' },
}

/** Deterministic table fallback — same guarantee as buildFallbackSections: always produces at least one usable row per table from whatever the brief contains, never blocks document generation. */
export function buildFallbackTables(input: SowContentInput): Record<SowTableSectionId, SowTableRow[]> {
  const tt = (isSowLanguage(input.language) ? FALLBACK_TABLE_STRINGS[input.language] : undefined) || FALLBACK_TABLE_STRINGS.en
  // FIX (bug — Deliverables/Timeline rendering completely empty): the old
  // `input.deliverables || 'default text'` check treats a whitespace-only
  // string (someone typed a space into the brief field, or left it with
  // trailing whitespace, then deleted the rest) as truthy — so the
  // fallback default never kicks in, and after .trim().filter(Boolean)
  // the line array comes out empty. Zero rows means SowTable renders
  // nothing at all, but the numbered section heading still prints above
  // it — a heading floating over blank space, which is exactly what
  // showed up on a real generated SOW. Trim BEFORE the `||` check so a
  // whitespace-only brief field is treated the same as an empty one.
  // FIX (SOW lifecycle independent pass 22, B4): the blank check above ran BEFORE the bullet marker was stripped, so a brief
  // field holding only "-" / "*" (a list started and then emptied) was truthy, stripped to nothing, and produced zero rows —
  // the same heading-over-blank-space failure. Lines are cleaned first and the default is used when none survive.
  const cleanLines = (raw: string | null | undefined, fallbackLine: string): string[] => {
    const lines = (raw || '').split('\n')
      .map(l => sanitizePlainText(l.trim().replace(/^[-*]\s*/, '')).trim())
      .filter(l => !isBlankText(l))
    return lines.length ? lines : [fallbackLine]
  }
  const deliverableLines = cleanLines(input.deliverables, tt.genericDeliverable)
  const timelineLines = cleanLines(input.timeline, tt.delivery)

  return {
    deliverables: deliverableLines.map(d => ({
      deliverable: sanitizePlainText(d),
      acceptanceCriteria: tt.approvedByClient,
      owner: 'Provider',
      targetDate: tt.tbc,
    })),
    timeline: timelineLines.map((t, i) => ({
      phase: `${tt.phase} ${i + 1}`,
      description: sanitizePlainText(t),
      duration: tt.tbc,
    })),
    roles: [
      { responsibility: tt.roleDelivery,  provider: '✓', client: '—', notes: '' },
      { responsibility: tt.roleFeedback,  provider: '—', client: '✓', notes: '' },
      { responsibility: tt.roleMaterials, provider: '—', client: '✓', notes: '' },
      { responsibility: tt.rolePayment,   provider: '—', client: '✓', notes: '' },
    ],
    // FEATURE (section-9 audit follow-up): only produced when the agency
    // actually chose 'milestones' — a hidden, empty table for every other
    // structure, same as the AI path. Amounts are computed here, never
    // asked of the model or invented — a 30/40/30 split across three
    // generic phases, rounded so the three amounts sum EXACTLY to the
    // contract value (the last milestone absorbs any rounding remainder,
    // same technique as the 50/50 split above and the CO counter-
    // negotiation rescale). The agency can freely retitle, re-split, add,
    // or remove rows in the editor afterward — this is just a sane,
    // guaranteed-to-foot starting point, not a final answer.
    payment_schedule: input.paymentStructure === 'milestones' ? (() => {
      const cv = Number(input.contractValue) || 0
      const m1 = roundCurrency(cv * 0.3)
      const m2 = roundCurrency(cv * 0.4)
      const m3 = roundCurrency(cv - m1 - m2)
      return [
        { milestone: tt.msKickoff, amount: String(m1), trigger: tt.trigSigning },
        { milestone: tt.msMid,     amount: String(m2), trigger: tt.trigMid },
        { milestone: tt.msFinal,   amount: String(m3), trigger: tt.trigFinal },
      ]
    })() : [],
  }
}
