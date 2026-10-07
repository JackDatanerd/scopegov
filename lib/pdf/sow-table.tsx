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
import { SOW_TABLE_SCHEMAS, columnLabel, localizeFixedCell, parseTableAmount, type SowTableSectionId, type SowTableRow } from '@/lib/sow/table-schema'

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

// SOW lifecycle pass 17, B3: the Payment Schedule 'amount' cell is free text and printed as typed ("6,000",
// "6500.50", no currency), while the signed-SOW milestone block prints "USD 6,000" / "USD 6,500.50". A readable
// amount is now formatted the same way in both; anything unreadable is printed as typed so nothing is hidden.
function cellText(sectionId: string, key: string, raw: string, currency?: string): string {
  if (!raw) return '—'
  if (sectionId !== 'payment_schedule' || key !== 'amount' || !currency) return raw
  const n = parseTableAmount(raw)
  if (n === null) return raw
  const whole = Math.round(Math.abs(n) * 100) % 100 === 0
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })
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
          <Text style={{ fontSize: 9, color: '#B0B0B0', fontFamily: PDF_FONT.italic }}>{language === 'sw' ? 'Itafafanuliwa' : language === 'es' ? 'Por definir' : language === 'fr' ? 'À définir' : language === 'pt' ? 'A definir' : language === 'de' ? 'Noch festzulegen' : 'To be defined'}</Text>
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
  // goes into the unsplittable group with the header row and the first data row (the box border is drawn as two
  // joined pieces for that). Short tables are kept whole by the caller and never take this branch.
  if (lead) {
    const line = '1 solid #E5E1D8'
    return (
      <View>
        <View wrap={false}>
          {lead}
          <View style={{ borderTop: line, borderLeft: line, borderRight: line, borderTopLeftRadius: 4, borderTopRightRadius: 4, overflow: 'hidden' }}>
            {header}
            {renderRow(rows[0], 0)}
          </View>
        </View>
        <View style={{ borderLeft: line, borderRight: line, borderBottom: line, borderBottomLeftRadius: 4, borderBottomRightRadius: 4, overflow: 'hidden' }}>
          {rows.slice(1).map((row, i) => renderRow(row, i + 1))}
        </View>
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
