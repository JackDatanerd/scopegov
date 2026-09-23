// lib/sow/table-schema.ts
//
// Doc-quality audit (Aug 2026): the SOW PDF rendered every section — even
// Deliverables, Timeline, and Roles & Responsibilities — as a single prose
// paragraph. Client-facing SOWs from established consulting firms present
// these three as tables (Deliverable/Acceptance Criteria/Owner/Date,
// Phase/Description/Duration, Responsibility/Provider/Client/Notes) because
// that's what actually gets scanned and referenced later, not read start to
// finish. This file is the one place that table shape is defined — the AI
// prompt, the in-app table editor, the PDF renderer, and the client portal
// page all import from here so they can never drift out of sync with each
// other.

export type SowTableSectionId = 'deliverables' | 'timeline' | 'roles' | 'payment_schedule'

export const TABLE_SECTION_IDS: SowTableSectionId[] = ['deliverables', 'timeline', 'roles', 'payment_schedule']

export function isTableSection(id: string): id is SowTableSectionId {
  return (TABLE_SECTION_IDS as string[]).includes(id)
}

export interface SowTableColumn {
  key: string
  label: string
  /** Relative flex width in the rendered table; columns without a width share remaining space evenly. */
  width?: number
  /** Fixed set of values for this column — rendered as a select in the editor instead of free text. */
  options?: string[]
  align?: 'left' | 'right' | 'center'
}

export interface SowTableSchema {
  columns: SowTableColumn[]
  /** Placeholder row shown when a table has zero rows, so the editor never renders a blank void. */
  emptyRowLabel: string
}

export const SOW_TABLE_SCHEMAS: Record<SowTableSectionId, SowTableSchema> = {
  deliverables: {
    columns: [
      { key: 'deliverable', label: 'Deliverable', width: 3 },
      { key: 'acceptanceCriteria', label: 'Acceptance Criteria', width: 4 },
      { key: 'owner', label: 'Owner', width: 1.4, options: ['Provider', 'Client', 'Joint'], align: 'center' },
      { key: 'targetDate', label: 'Target Date', width: 1.6, align: 'right' },
    ],
    emptyRowLabel: 'No deliverables added yet',
  },
  timeline: {
    columns: [
      { key: 'phase', label: 'Phase', width: 1.6 },
      { key: 'description', label: 'Description', width: 4 },
      { key: 'duration', label: 'Duration', width: 1.8, align: 'right' },
    ],
    emptyRowLabel: 'No phases added yet',
  },
  roles: {
    columns: [
      { key: 'responsibility', label: 'Responsibility', width: 2.6 },
      { key: 'provider', label: 'Provider', width: 1, options: ['✓', '—'], align: 'center' },
      { key: 'client', label: 'Client', width: 1, options: ['✓', '—'], align: 'center' },
      { key: 'notes', label: 'Notes', width: 2.4 },
    ],
    emptyRowLabel: 'No responsibilities added yet',
  },
  // FEATURE (section-9 audit follow-up): payment structure 'milestones'
  // has been selectable since the project-creation form existed — the
  // SOW boilerplate even prints "Payable in milestones as defined
  // below" — but there was never anywhere to actually define them.
  // createMilestones() (app/api/portal/sow/[token]/sign/route.ts) used
  // to silently collapse this to one lump-sum milestone on signing,
  // contradicting the SOW's own text. This table is the real fix: the
  // agency itemizes the schedule here, and the sign route now reads
  // these rows directly instead of guessing. `amount` is a plain
  // editable string like every other table cell — server-side
  // validation that it foots to the contract value lives at sign time
  // (see createMilestones), not in the editor itself, so an
  // in-progress edit is never blocked mid-typing.
  payment_schedule: {
    columns: [
      { key: 'milestone', label: 'Milestone', width: 2.6 },
      { key: 'amount', label: 'Amount', width: 1.2, align: 'right' },
      { key: 'trigger', label: 'Trigger / Due', width: 2.2 },
    ],
    emptyRowLabel: 'No milestones added yet',
  },
}

// FIX (section-9 audit, 9-G7): column labels were hardcoded English and
// rendered straight onto the client-facing PDF and portal page, so a
// Spanish or Swahili SOW printed "Deliverable / Acceptance Criteria /
// Owner / Target Date" over translated rows. Same policy as
// SOW_SECTION_TITLES in lib/ai/sow-content.ts: unknown language falls
// back to the English label rather than emitting a blank header.
const TABLE_COLUMN_LABELS: Record<string, Record<string, string>> = {
  es: {
    deliverable: 'Entregable', acceptanceCriteria: 'Criterios de Aceptación', owner: 'Responsable', targetDate: 'Fecha Objetivo',
    phase: 'Fase', description: 'Descripción', duration: 'Duración',
    responsibility: 'Responsabilidad', provider: 'Agencia', client: 'Cliente', notes: 'Notas',
    milestone: 'Hito', amount: 'Importe', trigger: 'Condición / Vencimiento',
  },
  fr: {
    deliverable: 'Livrable', acceptanceCriteria: 'Critères d\'Acceptation', owner: 'Responsable', targetDate: 'Date Cible',
    phase: 'Phase', description: 'Description', duration: 'Durée',
    responsibility: 'Responsabilité', provider: 'Agence', client: 'Client', notes: 'Notes',
    milestone: 'Jalon', amount: 'Montant', trigger: 'Déclencheur / Échéance',
  },
  pt: {
    deliverable: 'Entregável', acceptanceCriteria: 'Critérios de Aceitação', owner: 'Responsável', targetDate: 'Data Prevista',
    phase: 'Fase', description: 'Descrição', duration: 'Duração',
    responsibility: 'Responsabilidade', provider: 'Agência', client: 'Cliente', notes: 'Notas',
    milestone: 'Marco', amount: 'Valor', trigger: 'Gatilho / Vencimento',
  },
  de: {
    deliverable: 'Leistung', acceptanceCriteria: 'Abnahmekriterien', owner: 'Verantwortlich', targetDate: 'Zieltermin',
    phase: 'Phase', description: 'Beschreibung', duration: 'Dauer',
    responsibility: 'Verantwortung', provider: 'Agentur', client: 'Kunde', notes: 'Anmerkungen',
    milestone: 'Meilenstein', amount: 'Betrag', trigger: 'Auslöser / Fällig',
  },
  sw: {
    deliverable: 'Kinachotolewa', acceptanceCriteria: 'Vigezo vya Kukubalika', owner: 'Mhusika', targetDate: 'Tarehe Lengwa',
    phase: 'Awamu', description: 'Maelezo', duration: 'Muda',
    responsibility: 'Jukumu', provider: 'Wakala', client: 'Mteja', notes: 'Maelezo',
    milestone: 'Hatua', amount: 'Kiasi', trigger: 'Kichocheo / Tarehe',
  },
}

/** Column label in the document's language, falling back to the English default. */
export function columnLabel(col: SowTableColumn, language?: string): string {
  if (!language || language === 'en') return col.label
  return TABLE_COLUMN_LABELS[language]?.[col.key] || col.label
}

// FIX (fix round, SOW-B2): the signed-SOW payment-milestones block (rendered
// from payment_milestones once signed, in place of the authored
// payment_schedule table) had its own hardcoded "Milestone"/"Amount"/"Due"
// headers — every other table in the document routes through columnLabel
// above, so a signed non-English SOW translated everywhere except this one
// block. Reuses the same milestone/amount translations (the milestone block
// shows a due *date* rather than the combined "Trigger / Due" column, so
// that gets its own short label per language instead of reusing `trigger`'s).
const MILESTONE_DUE_LABELS: Record<string, string> = {
  es: 'Vencimiento', fr: 'Échéance', pt: 'Vencimento', de: 'Fällig', sw: 'Tarehe',
}

/** Milestone/Amount/Due header labels for the signed-SOW milestone block, in the document's language. */
export function milestoneBlockLabels(language?: string): { milestone: string; amount: string; due: string } {
  if (!language || language === 'en') return { milestone: 'Milestone', amount: 'Amount', due: 'Due' }
  return {
    milestone: TABLE_COLUMN_LABELS[language]?.milestone || 'Milestone',
    amount: TABLE_COLUMN_LABELS[language]?.amount || 'Amount',
    due: MILESTONE_DUE_LABELS[language] || 'Due',
  }
}

export type SowTableRow = Record<string, string>

/**
 * FIX (section-9 audit, 9-G6): the payment_schedule `amount` cell is a
 * free-text input, and every consumer read it with a bare `Number(...)`.
 * A perfectly ordinary entry like "1,500" or "$1,500.00" — which is what
 * anyone typing an amount into a text box actually writes — is NaN to
 * `Number`, so the row silently dropped out of the send-time validation
 * set and the agency got "Add at least one milestone to the Payment
 * Schedule" on a table that visibly had three. Worse, a schedule that
 * looked correct could fail the foot-to-contract-value check for reasons
 * invisible on screen.
 *
 * Parse the way a human means it: strip currency symbols, spaces and
 * thousands separators, keep the sign and decimal point. Returns null for
 * anything that still isn't a finite number, so callers can distinguish
 * "blank/unparseable" from "zero".
 */
export function parseTableAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null

  // Find every numeric token ("1.500,00", "1 500,00", "$2,500", "12"). A cell that
  // holds more than one ("Net 30: 500", "10-15", "1e3") is ambiguous, so it is
  // reported as unreadable instead of being silently concatenated into one number.
  const tokens = raw.match(/\d[\d.,\s'\u2019\u00a0\u202f]*/g)
  if (!tokens) return null
  const cleanedTokens = tokens.map(t => t.replace(/[\s'\u2019\u00a0\u202f]+$/g, ''))
  if (cleanedTokens.length !== 1) return null
  let token = cleanedTokens[0].replace(/[\s'\u2019\u00a0\u202f]/g, '')

  // Work out which separator is the decimal point.
  const lastDot = token.lastIndexOf('.')
  const lastComma = token.lastIndexOf(',')
  let decimalSep: '.' | ',' | null = null
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal ("1.500,00" / "1,500.00").
    decimalSep = lastDot > lastComma ? '.' : ','
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = (lastDot !== -1 ? '.' : ',') as '.' | ','
    const parts = token.split(sep)
    const tail = parts[parts.length - 1]
    // Repeated separator ("1.500.000") or exactly three digits after a single one
    // ("1.500", "1,500") is a thousands grouping; one or two digits is a decimal.
    if (parts.length === 2 && tail.length !== 3) decimalSep = sep
    else if (parts.length === 2 && tail.length === 3 && parts[0] === '0') decimalSep = sep // "0.500"
  }

  let normalized: string
  if (decimalSep) {
    const thousandsSep = decimalSep === '.' ? ',' : '.'
    normalized = token.split(thousandsSep).join('').replace(decimalSep, '.')
  } else {
    normalized = token.replace(/[.,]/g, '')
  }
  let n = Number(normalized)
  if (!Number.isFinite(n)) return null

  // "1.5k" / "2K" shorthand.
  const after = raw.slice(raw.indexOf(tokens[0]) + tokens[0].length)
  if (/^\s*k\b/i.test(after)) n *= 1000

  // Accounting-style negatives: "(500)"/"($500)" or a leading minus ("-500", "-$500").
  // FIX (fix round, SOW-B1): this used to only ever test `before` for a literal '-'
  // character — parens were never actually checked despite the comment always having
  // claimed "(500)" was handled. A row like "(500)" (a common way to write a credit/
  // refund milestone) silently parsed as +500.
  const before = raw.slice(0, raw.indexOf(tokens[0]))
  const leadingMinus = /-\s*[^\d]*$/.test(before) && !/\d/.test(before)
  const wrappedInParens = /\([^\d]*$/.test(before) && /^[^\d]*\)/.test(after)
  if (leadingMinus || wrappedInParens) n = -n
  return n
}

/** A blank row matching a section's schema, for the "+ Add row" editor action. */
export function blankRow(sectionId: SowTableSectionId): SowTableRow {
  const schema = SOW_TABLE_SCHEMAS[sectionId]
  const row: SowTableRow = {}
  for (const col of schema.columns) row[col.key] = col.options ? col.options[col.options.length - 1] : ''
  return row
}
