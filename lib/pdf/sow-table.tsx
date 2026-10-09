// lib/pdf/sow-table.tsx
//
// FIX (doc-quality audit, Aug 2026): Deliverables, Timeline, and the new
// Roles & Responsibilities section render as tables now instead of a
// single prose paragraph — this was the single biggest visual gap versus
// a traditional consulting-firm SOW, where these sections are always
// scannable tables (Deliverable/Acceptance Criteria/Owner/Date,
// Phase/Description/Duration, Responsibility/Provider/Client/Notes), not
// paragraphs. Column shape is schema-driven from lib/sow/table-schema.ts
// so this can never drift out of sync with the editor or the AI prompt.

import React from 'react'
import { View, Text } from '@react-pdf/renderer'
import { SOW_TABLE_SCHEMAS, columnLabel, localizeFixedCell, toBeDefinedLabel, parseTableAmount, type SowTableSectionId, type SowTableRow } from '@/lib/sow/table-schema'

import { PDF_FONT } from '@/lib/pdf/fonts'
// FIX (section-9 audit, 9-G7): column headers were hardcoded English and
// printed straight onto the client-facing document, so a Spanish or
// Swahili SOW rendered "Deliverable / Acceptance Criteria / Owner /
// Target Date" above translated rows. See columnLabel in
// lib/sow/table-schema.ts.
// FIX (SOW lifecycle independent pass 12, B1/B2): flex columns had no gutter, so a right-aligned amount butted
// against the next column's text ("5000On signing", header "AMOUNTTRIGGER / DUE") and long cell text ran straight
// into the next column. Every column but the last now carries a right gutter. Each row is also unsplittable: a row
// that straddled a page break printed its first lines on one page and the rest (or just the owner/date cells) on the next.
export const COL_GUTTER = 10

// ── Table height estimate ────────────────────────────────────────────────────────────────────────────────────────────
// FIX (doc-quality harmonisation): whether a table may split across pages was decided by row count (and later character
// count), neither of which is how tall a table actually is: four rows of one line and four rows of four wrapped lines are
// both "4 rows". The renderer now asks for an estimate of the rendered height instead. It deliberately OVERestimates (wide
// average glyph, extra allowance for word wrapping) because the cost of a wrong guess is asymmetric: a table that is kept
// whole but turns out taller than the page loses text off the page, whereas an overestimate merely lets a table flow.
export const PDF_CONTENT_WIDTH = 595.28 - 2 * 48     // A4 width less the page's 48pt side padding
const TABLE_FONT_SIZE = 9
const TABLE_LINE_HEIGHT = 1.4
const TABLE_CHAR_WIDTH = TABLE_FONT_SIZE * 0.56      // Noto Sans averages ~0.52em; rounded up
const TABLE_WRAP_ALLOWANCE = 1.08                    // words do not break at the exact column edge
const TABLE_ROW_PADDING = 2 * 6 + 1                  // paddingVertical 6 + bottom border
const TABLE_HEADER_HEIGHT = 20
const TABLE_CELL_PADDING_X = 2 * 8                   // row paddingHorizontal 8
/** A table estimated at or below this height is never split across pages; it moves whole to the next page if it does not fit. */
export const TABLE_KEEP_TOGETHER_MAX_HEIGHT = 480
/** Above this a table must be allowed to flow: an unsplittable block taller than the page cannot be drawn. */
export const TABLE_UNSPLITTABLE_SAFE_HEIGHT = 640
/** When a table does have to split, at least this many rows stay with the heading above the break and move below it. */
export const TABLE_MIN_ROWS_AT_BREAK = 2

export function estimateSowTableHeight(sectionId: SowTableSectionId, rows: SowTableRow[] | undefined): number {
  const schema = SOW_TABLE_SCHEMAS[sectionId]
  if (!rows || rows.length === 0) return 48 // the dashed "to be defined" placeholder
  const totalFlex = schema.columns.reduce((sum, c) => sum + (c.width ?? 1), 0)
  const innerWidth = PDF_CONTENT_WIDTH - 2 - TABLE_CELL_PADDING_X
  const lastCol = schema.columns.length - 1
  let height = TABLE_HEADER_HEIGHT + 2
  for (const row of rows) {
    let lines = 1
    schema.columns.forEach((col, ci) => {
      const colWidth = ((col.width ?? 1) / totalFlex) * innerWidth - (ci < lastCol ? COL_GUTTER : 0)
      const perLine = Math.max(1, Math.floor(colWidth / TABLE_CHAR_WIDTH))
      const text = String(row?.[col.key] ?? '')
      const cellLines = text.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil((part.length * TABLE_WRAP_ALLOWANCE) / perLine)), 0)
      lines = Math.max(lines, cellLines)
    })
    height += lines * TABLE_FONT_SIZE * TABLE_LINE_HEIGHT + TABLE_ROW_PADDING
  }
  return Math.round(height)
}

// SOW lifecycle pass 17, B3: the Payment Schedule 'amount' cell is free text and printed as typed ("6,000",
// "6500.50", no currency), while the signed-SOW milestone block prints "USD 6,000" / "USD 6,500.50". A readable
// amount is now formatted the same way in both; anything unreadable is printed as typed so nothing is hidden.
function cellText(sectionId: string, key: string, raw: string, currency?: string): string {
  if (!raw) return '—'
  if (sectionId !== 'payment_schedule' || key !== 'amount' || !currency) return raw
  const n = parseTableAmount(raw)
  if (n === null) return raw
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  // FIX (SOW lifecycle pass 21, B1): sign goes after the currency code, like the signed milestone block ("USD -500"), not before it.
  return `${currency} ${n < 0 ? '-' : ''}${body}`
}

export function SowTable({ sectionId, rows, language, lead, currency }: { sectionId: SowTableSectionId; rows: SowTableRow[]; language?: string; lead?: React.ReactNode; currency?: string }) {
  const schema = SOW_TABLE_SCHEMAS[sectionId]

  // FIX (bug — numbered section heading printed over completely blank
  // space): returning null here on an empty table left the "N. Title"
  // heading above it with nothing visibly underneath — happened on a
  // real generated SOW where the deliverables/timeline brief was
  // effectively blank. Root cause is fixed upstream (see
  // buildFallbackTables' whitespace-trim fix in lib/ai/sow-content.ts),
  // but this is the last line of defense: a table can still legitimately
  // end up empty later (someone deletes every row in the editor), and a
  // signed legal document silently missing its Deliverables section is a
  // worse failure than an ugly one — so show a visible placeholder
  // instead of hiding it, same principle as Out of Scope's own "To be
  // defined" fallback text.
  if (!rows || rows.length === 0) {
    return (
      <>
        {lead}
        <View style={{ border: '1 dashed #D8D4C8', borderRadius: 4, padding: '10 12' }}>
          <Text style={{ fontSize: 9, color: '#B0B0B0', fontFamily: PDF_FONT.italic }}>{toBeDefinedLabel(language)}</Text>
        </View>
      </>
    )
  }

  const totalFlex = schema.columns.reduce((sum, c) => sum + (c.width ?? 1), 0)
  const flexOf = (w?: number) => (w ?? 1) / totalFlex

  const s = {
    box:    { border: '1 solid #E5E1D8', borderRadius: 4, overflow: 'hidden' as const },
    hdrRow: { flexDirection: 'row' as const, backgroundColor: '#F9F8F5', borderBottom: '1 solid #E5E1D8', paddingVertical: 5, paddingHorizontal: 8 },
    th:     { fontSize: 7.5, fontFamily: PDF_FONT.bold, color: '#909090', textTransform: 'uppercase' as const, letterSpacing: 0.4 },
    row:    { flexDirection: 'row' as const, borderBottom: '1 solid #F2F0EA', paddingVertical: 6, paddingHorizontal: 8 },
    lastRow:{ borderBottom: 'none' as const },
    td:     { fontSize: 9, color: '#1A1A1A', lineHeight: 1.4 },
  }

  const lastCol = schema.columns.length - 1
  const header = (
    <View style={s.hdrRow}>
      {schema.columns.map((col, ci) => (
        <Text key={col.key} style={[s.th, { flex: flexOf(col.width), textAlign: col.align || 'left', paddingRight: ci < lastCol ? COL_GUTTER : 0 }]}>
          {columnLabel(col, language)}
        </Text>
      ))}
    </View>
  )
  const renderRow = (row: SowTableRow, i: number) => (
    <View key={i} wrap={false} style={[s.row, i === rows.length - 1 ? s.lastRow : {}]}>
      {schema.columns.map((col, ci) => (
        <Text key={col.key} style={[s.td, { flex: flexOf(col.width), textAlign: col.align || 'left', paddingRight: ci < lastCol ? COL_GUTTER : 0 }]}>
          {cellText(sectionId, col.key, localizeFixedCell(col.key, row[col.key] || '', language), currency)}
        </Text>
      ))}
    </View>
  )

  // FIX (SOW lifecycle independent pass 12, B3): a long table is allowed to flow across pages, so its section heading
  // goes into the unsplittable group with the header row and the first data rows (the box border is drawn as joined
  // pieces for that). Short tables are kept whole by the caller and never take this branch.
  // FIX (doc-quality harmonisation): the break may no longer leave a lone row behind. The first TABLE_MIN_ROWS_AT_BREAK
  // rows travel with the heading and header, and the last TABLE_MIN_ROWS_AT_BREAK rows are one unsplittable group, so a
  // break always has at least two rows on each side of it. A table of three rows or fewer is a single group (unless it is
  // so tall that a single block could not be drawn, in which case only the first row travels with the heading).
  if (lead) {
    const line = '1 solid #E5E1D8'
    const n = rows.length
    // The rows that would travel as one unsplittable group with the heading must themselves fit on a page; if they would not
    // (a few rows of enormous text), only the first row travels with the heading and nothing is grouped at the foot.
    const headCandidate = n <= TABLE_MIN_ROWS_AT_BREAK + 1 ? rows : rows.slice(0, TABLE_MIN_ROWS_AT_BREAK)
    const headFits = estimateSowTableHeight(sectionId, headCandidate) <= TABLE_UNSPLITTABLE_SAFE_HEIGHT
    const headCount = headFits ? headCandidate.length : 1
    const tailCandidate = rows.slice(Math.max(headCount, n - TABLE_MIN_ROWS_AT_BREAK))
    const tailFits = estimateSowTableHeight(sectionId, tailCandidate) <= TABLE_UNSPLITTABLE_SAFE_HEIGHT
    const tailCount = n - headCount >= TABLE_MIN_ROWS_AT_BREAK && tailFits ? TABLE_MIN_ROWS_AT_BREAK : 0
    const headRows = rows.slice(0, headCount)
    const midRows  = rows.slice(headCount, n - tailCount)
    const tailRows = rows.slice(n - tailCount)
    const hasRest  = midRows.length > 0 || tailRows.length > 0
    const closing  = { borderBottom: line, borderBottomLeftRadius: 4, borderBottomRightRadius: 4 }
    return (
      <View>
        <View wrap={false}>
          {lead}
          <View style={{ borderTop: line, borderLeft: line, borderRight: line, borderTopLeftRadius: 4, borderTopRightRadius: 4, overflow: 'hidden', ...(hasRest ? {} : closing) }}>
            {header}
            {headRows.map((row, i) => renderRow(row, i))}
          </View>
        </View>
        {hasRest && (
          <View style={{ borderLeft: line, borderRight: line, overflow: 'hidden', ...closing }}>
            {midRows.map((row, i) => renderRow(row, headCount + i))}
            {tailRows.length > 0 && <View wrap={false}>{tailRows.map((row, i) => renderRow(row, n - tailCount + i))}</View>}
          </View>
        )}
      </View>
    )
  }

  return (
    // FIX (re-audit): wrap={false} forced this whole table to stay on one page; the box may split between rows.
    <View style={s.box}>
      {header}
      {rows.map(renderRow)}
    </View>
  )
}
