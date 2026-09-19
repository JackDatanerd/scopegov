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
import { SOW_TABLE_SCHEMAS, columnLabel, type SowTableSectionId, type SowTableRow } from '@/lib/sow/table-schema'

import { PDF_FONT } from '@/lib/pdf/fonts'
// FIX (section-9 audit, 9-G7): column headers were hardcoded English and
// printed straight onto the client-facing document, so a Spanish or
// Swahili SOW rendered "Deliverable / Acceptance Criteria / Owner /
// Target Date" above translated rows. See columnLabel in
// lib/sow/table-schema.ts.
export function SowTable({ sectionId, rows, language }: { sectionId: SowTableSectionId; rows: SowTableRow[]; language?: string }) {
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
      <View style={{ border: '1 dashed #D8D4C8', borderRadius: 4, padding: '10 12' }}>
        <Text style={{ fontSize: 9, color: '#B0B0B0', fontFamily: PDF_FONT.italic }}>To be defined</Text>
      </View>
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

  return (
    // FIX (re-audit): wrap={false} forced this whole table to stay on one
    // page — the outer section wrapper in renderer.tsx already allows
    // table sections to split across pages, but this inner box overrode
    // that by refusing to split itself. A table taller than one full page
    // (a large enterprise SOW with many deliverables/timeline phases)
    // would overflow off the bottom rather than paginate. Let it wrap like
    // everything else; react-pdf splits at row boundaries.
    <View style={s.box}>
      <View style={s.hdrRow}>
        {schema.columns.map(col => (
          <Text key={col.key} style={[s.th, { flex: flexOf(col.width), textAlign: col.align || 'left' }]}>
            {columnLabel(col, language)}
          </Text>
        ))}
      </View>
      {rows.map((row, i) => (
        <View key={i} style={[s.row, i === rows.length - 1 ? s.lastRow : {}]}>
          {schema.columns.map(col => (
            <Text key={col.key} style={[s.td, { flex: flexOf(col.width), textAlign: col.align || 'left' }]}>
              {row[col.key] || '—'}
            </Text>
          ))}
        </View>
      ))}
    </View>
  )
}
