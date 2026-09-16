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

export type SowTableRow = Record<string, string>

/** A blank row matching a section's schema, for the "+ Add row" editor action. */
export function blankRow(sectionId: SowTableSectionId): SowTableRow {
  const schema = SOW_TABLE_SCHEMAS[sectionId]
  const row: SowTableRow = {}
  for (const col of schema.columns) row[col.key] = col.options ? col.options[col.options.length - 1] : ''
  return row
}
