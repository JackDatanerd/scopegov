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

import { escapeHtml, sanitizePlainText } from '@/lib/utils/sanitize'
import { amountsMentioned } from '@/lib/sow/validate-send'
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
}

export interface AgencyStandards {
  revisionPolicy?: string | null
  paymentTerms?: string | null
  outOfScopeClauses?: string[] | null
  assumptions?: string[] | null
}

const norm = (t: string) => t.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

function cleanClauses(list: string[] | null | undefined): string[] {
  return (Array.isArray(list) ? list : [])
    .map(c => sanitizePlainText(String(c ?? '')).slice(0, 500))
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
  const rp = sanitizePlainText(standards.revisionPolicy || '').slice(0, 1500)
  if (rp) lines.push(`- The agency's standard revision-policy wording — reflect it in the Revision Policy section: "${rp}"`)
  const pt = sanitizePlainText(standards.paymentTerms || '').slice(0, 1500)
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
function conflictingRoundCount(text: string, revisionRounds: number): boolean {
  const matches = text.matchAll(/(\d+)\s*rounds?\b/gi)
  for (const m of matches) {
    const n = Number(m[1])
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
  const revisionPolicy = sanitizePlainText(standards.revisionPolicy || '').slice(0, 1500)
  // FIX (fresh independent audit, section 9): skip the append rather than let the document
  // state two different revision-round counts in the same section — see
  // conflictingRoundCount's own comment. Nothing else downstream (validate-send.ts included)
  // ever cross-checks the Revision Policy section's prose against metadata.revisionRounds, so
  // this is the only place that can catch it.
  if (!(typeof revisionRounds === 'number' && conflictingRoundCount(revisionPolicy, revisionRounds))) {
    addParagraph('revisions', revisionPolicy)
  }
  addParagraph('payment', sanitizePlainText(standards.paymentTerms || '').slice(0, 1500))
  return out
}

/**
 * The Payment Terms prose is model-written, but the contract value is data. If the prose does
 * not state the agreed value (the model paraphrased, skipped it, or the value changed after
 * drafting), append one deterministic sentence so the document can never disagree with itself.
 */
export function ensureContractValueStated(paymentHtml: string, contractValue: number, currency: string): string {
  if (!Number.isFinite(contractValue) || contractValue <= 0) return paymentHtml
  const stated = amountsMentioned(norm(paymentHtml)).some(n => Math.abs(n - contractValue) < 0.01)
  if (stated) return paymentHtml
  const pretty = contractValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${paymentHtml}<p><strong>${escapeHtml(currency)} ${pretty}</strong></p>`
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

// ── 1. Boilerplate sections — deterministic, never asked of the model ──
//
// These three sections are never sent to the AI (see AI_SECTION_IDS
// below), so language-switching them means translating the template
// itself rather than instructing a model. Only the languages in
// SOW_LANGUAGE_NAMES are supported; an unrecognized code falls back to
// English rather than emitting a mixed-language document.

const BOILERPLATE_TEMPLATES: Record<string, (agency: string, client: string, law: string) => Record<string, string>> = {
  en: (agency, client, law) => ({
    parties: `<p>This Statement of Work is entered into between <strong>${agency}</strong> ("Agency") and <strong>${client}</strong> ("Client").</p>`,
    governing_law: `<p>This Agreement is governed by the laws of ${law}.</p>`,
    signature: `<p>By signing below, both parties agree to the terms of this Statement of Work.</p>`,
  }),
  es: (agency, client, law) => ({
    parties: `<p>Este Acuerdo de Alcance de Trabajo se celebra entre <strong>${agency}</strong> ("la Agencia") y <strong>${client}</strong> ("el Cliente").</p>`,
    governing_law: `<p>Este Acuerdo se rige por las leyes de ${law}.</p>`,
    signature: `<p>Al firmar a continuación, ambas partes aceptan los términos de este Acuerdo de Alcance de Trabajo.</p>`,
  }),
  fr: (agency, client, law) => ({
    parties: `<p>Le présent Énoncé des travaux est conclu entre <strong>${agency}</strong> (l'« Agence ») et <strong>${client}</strong> (le « Client »).</p>`,
    governing_law: `<p>Le présent Accord est régi par les lois de ${law}.</p>`,
    signature: `<p>En signant ci-dessous, les deux parties acceptent les termes du présent Énoncé des travaux.</p>`,
  }),
  pt: (agency, client, law) => ({
    parties: `<p>Este Termo de Abertura de Escopo é celebrado entre <strong>${agency}</strong> ("Agência") e <strong>${client}</strong> ("Cliente").</p>`,
    governing_law: `<p>Este Acordo é regido pelas leis de ${law}.</p>`,
    signature: `<p>Ao assinar abaixo, ambas as partes concordam com os termos deste Termo de Abertura de Escopo.</p>`,
  }),
  de: (agency, client, law) => ({
    parties: `<p>Diese Leistungsbeschreibung wird zwischen <strong>${agency}</strong> ("Agentur") und <strong>${client}</strong> ("Kunde") geschlossen.</p>`,
    governing_law: `<p>Diese Vereinbarung unterliegt den Gesetzen von ${law}.</p>`,
    signature: `<p>Mit der nachstehenden Unterschrift stimmen beide Parteien den Bedingungen dieser Leistungsbeschreibung zu.</p>`,
  }),
  sw: (agency, client, law) => ({
    parties: `<p>Hati hii ya Wigo wa Kazi imeingiwa kati ya <strong>${agency}</strong> ("Wakala") na <strong>${client}</strong> ("Mteja").</p>`,
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
  return SOW_SECTION_TITLES[language]?.[id] || fallback
}

export function buildBoilerplateSections(input: SowContentInput): Record<string, string> {
  const agency = escapeHtml(input.agencyName)
  const client = escapeHtml(input.clientName)
  const law    = escapeHtml(input.governingLaw)
  const template = BOILERPLATE_TEMPLATES[input.language || 'en'] || BOILERPLATE_TEMPLATES.en
  return template(agency, client, law)
}

// ── 2. Prompt — plain delimited content only, never JSON ───────────────

const SECTION_MARKER = (id: string) => `<<<SECTION:${id}>>>`
const TABLE_MARKER   = (id: string) => `<<<TABLE:${id}>>>`
const TABLE_END      = '<<<ENDTABLE>>>'

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
  const languageName = SOW_LANGUAGE_NAMES[input.language || 'en']
  const languageInstruction = languageName && languageName !== 'English'
    ? `\n\nWrite ALL drafted section content and table row text in ${languageName}. Keep the section/table MARKER lines themselves exactly as specified below (in English, unchanged) — only the content after each marker is in ${languageName}.`
    : ''

  return `You are a professional contract drafter for a creative/digital agency.
Draft the content for a Statement of Work. Use ONLY the exact figures provided below. Never invent payment amounts, fees, rates, or revision counts.

Agency: ${input.agencyName}
Client: ${input.clientName}
Project: ${input.projectName}${input.projectDisc ? ` (${input.projectDisc})` : ''}
Project type: ${input.projectType}
Contract value: ${input.currency} ${input.contractValue}

Scope brief:
Objective: ${input.objective || 'Not specified'}
Deliverables:
${input.deliverables || 'As discussed'}

Out of scope (MUST be explicitly excluded):
${input.outOfScope || 'To be defined'}

Timeline: ${input.timeline || 'To be agreed'}
Payment structure: ${input.paymentLabel}
Revision rounds: ${input.revisionRounds}
Governing law: ${input.governingLaw}

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
- Payment section must state exactly "${input.currency} ${input.contractValue}" and the exact payment structure above. Do NOT invent percentages or amounts beyond what's stated.
- Out of scope section must list every item from the out-of-scope brief as explicit exclusions. Be specific.
- Revision policy must reference exactly ${input.revisionRounds} revision round(s).
- Deliverables table rows must cover every item in the deliverables brief above — one row per deliverable, not grouped.
- Roles table must reflect that ${input.agencyName} is the Provider and ${input.clientName} is the Client.
- Write with professional, authoritative language appropriate for a legal document.
- Never add a "late fee rate" or "revision fee" unless explicitly provided.${standardsPromptBlock(input.standards)}${wantsPaymentSchedule ? '\n- Payment Schedule table: propose sensible milestone titles and trigger conditions based on the deliverables/timeline above. Amount must be exactly 0 on every row — never write a dollar figure or percentage there.' : ''}${languageInstruction}${reminder}`
}

// ── 3. Parsers — tolerant of anything except the markers themselves ────

export class SowContentParseError extends Error {
  constructor(public missingOrEmpty: string[]) {
    super(`Missing or empty sections: ${missingOrEmpty.join(', ')}`)
  }
}

export function parseDelimitedSections(raw: string): Record<string, string> {
  // Split on marker lines, keeping the captured id. This succeeds even if
  // the model added a stray preamble sentence or wrapped the whole thing
  // in a code fence — we only care that the markers themselves are intact,
  // not that the surrounding text is "clean". Table blocks are cut out
  // first so their pipe-delimited rows can never be mistaken for prose.
  const withoutTables = raw.replace(/<<<TABLE:[a-z_]+>>>[\s\S]*?<<<ENDTABLE>>>/g, '')
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
    const content = (parts[i + 1] || '').trim()
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

function normalizeEnumCell(value: string, options: string[]): string {
  const v = value.trim().toLowerCase()

  // Tick/dash columns (roles table): decide by meaning, not first letter.
  if (options.length === 2 && options[0] === '✓') {
    if (AFFIRMATIVE.includes(v)) return options[0]
    if (NEGATIVE.includes(v))    return options[1]
    // Anything else non-empty reads as "this party is involved".
    return v ? options[0] : options[1]
  }

  // Word columns (Owner): exact, then prefix, then a small synonym map.
  const exact = options.find(o => o.toLowerCase() === v)
  if (exact) return exact
  const prefix = options.find(o => v.startsWith(o.toLowerCase()) || o.toLowerCase().startsWith(v))
  if (prefix) return prefix
  const SYNONYMS: Record<string, string> = {
    agency: 'Provider', vendor: 'Provider', supplier: 'Provider', contractor: 'Provider',
    us: 'Provider', we: 'Provider', consultant: 'Provider', freelancer: 'Provider',
    customer: 'Client', them: 'Client', 'client team': 'Client',
    both: 'Joint', shared: 'Joint', mutual: 'Joint', together: 'Joint',
  }
  const mapped = SYNONYMS[v]
  if (mapped && options.includes(mapped)) return mapped

  return options[options.length - 1]
}

export function parseTableSections(raw: string): Record<SowTableSectionId, SowTableRow[]> {
  const result: Record<SowTableSectionId, SowTableRow[]> = { deliverables: [], timeline: [], roles: [], payment_schedule: [] }

  for (const id of TABLE_IDS) {
    const re = new RegExp(`<<<TABLE:${id}>>>([\\s\\S]*?)<<<ENDTABLE>>>`)
    const match = raw.match(re)
    if (!match) continue

    const schema = SOW_TABLE_SCHEMAS[id]
    const lines = match[1].split('\n').map(l => l.trim()).filter(Boolean)
      // Skip a stray column-header line if the model echoed it back despite instructions
      .filter(l => !l.startsWith('('))

    const rows: SowTableRow[] = []
    for (const line of lines) {
      const cells = line.split('|').map(c => c.trim())
      if (cells.length < schema.columns.length) continue
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
    revisions: r => `Kazi hii inajumuisha mzunguko ${r} wa marekebisho kwa kila kinachotolewa. Mizunguko ya ziada inaweza kutozwa kando au kushughulikiwa kupitia Agizo la Mabadiliko.`,
    ip: a => `Baada ya malipo kamili, matokeo yote ya mwisho yatakuwa mali ya Mteja. ${a} inabaki na haki ya kuonyesha kazi hiyo katika kumbukumbu zake za kazi isipokuwa kama imekubaliwa vinginevyo kwa maandishi.`,
    confidentiality: 'Pande zote mbili zinakubali kutunza siri taarifa zozote za kimiliki au zisizo za umma zilizoshirikiwa wakati wa kazi hii.',
    termination: 'Upande wowote unaweza kusitisha kazi hii kwa taarifa ya maandishi. Mteja atatozwa kwa kazi yote iliyokamilika hadi tarehe ya kusitishwa.',
    dispute: 'Mgogoro wowote unaotokana na Hati hii ya Wigo wa Kazi utashughulikiwa kwanza kwa majadiliano ya nia njema kati ya pande husika kabla ya kufuata utatuzi rasmi chini ya sheria inayotumika iliyotajwa hapa chini.',
  },
}

export function buildFallbackSections(input: SowContentInput): Record<string, string> {
  const t = FALLBACK_STRINGS[input.language || 'en'] || FALLBACK_STRINGS.en

  const outOfScopeItems = (input.outOfScope || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => `<li>${escapeHtml(l.replace(/^[-*]\s*/, ''))}</li>`).join('')

  return {
    overview: `<p>${escapeHtml((input.objective || '').trim() ||
      t.overviewDefault(input.agencyName, input.projectType, input.clientName))}</p>`,
    oos: outOfScopeItems
      ? `<p>${t.oosIntro}</p><ul>${outOfScopeItems}</ul>`
      : `<p>${t.oosNone}</p>`,
    assumptions: `<p>${t.assumptions}</p>`,
    payment: `<p>${t.paymentTotal}: <strong>${escapeHtml(String(input.currency))} ${escapeHtml(String(input.contractValue))}</strong>. ${t.paymentStructure}: ${escapeHtml(input.paymentLabel)}.</p>`,
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
  en: { tbc: 'To be confirmed', approvedByClient: 'Reviewed and approved by Client', phase: 'Phase', genericDeliverable: 'Project deliverable as discussed with the Agency', delivery: 'Delivery',
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
  const tt = FALLBACK_TABLE_STRINGS[input.language || 'en'] || FALLBACK_TABLE_STRINGS.en
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
  const deliverableLines = ((input.deliverables || '').trim() || tt.genericDeliverable)
    .split('\n').map(l => l.trim().replace(/^[-*]\s*/, '')).filter(Boolean)

  const timelineLines = ((input.timeline || '').trim() || tt.delivery)
    .split('\n').map(l => l.trim().replace(/^[-*]\s*/, '')).filter(Boolean)

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
