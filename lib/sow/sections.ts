// lib/sow/sections.ts
//
// Server-owned SOW section shaping, extracted out of
// app/api/sow/[id]/route.ts: a Next.js route module may only export route
// handlers, so these helpers could not live there.

import { sanitizeRichText, sanitizePlainText, decodeHtmlEntities } from '@/lib/utils/sanitize'
import { isTableSection, SOW_TABLE_SCHEMAS, type SowTableSectionId } from '@/lib/sow/table-schema'
import { SOW_SECTION_DEFS, sectionTitle } from '@/lib/ai/sow-content'

// FIX (section-9 audit): PATCH /api/sow/[id] sanitized section content and
// table cells against XSS (see lib/utils/sanitize.ts) but never capped
// their LENGTH — unlike api/sow/generate, which explicitly caps brief
// input fields "for cost/latency reasons" (and, just as much, storage).
// An EDIT_SOW member calling this route directly (bypassing the editor's
// own UI, same class of gap this codebase treats seriously everywhere
// else) could store an arbitrarily large section — up to whatever the
// hosting platform's own request-body ceiling allows — bloating storage
// and risking slow PDF renders and portal page loads for every future
// viewer of that document, client included. Bounds are generous (well
// beyond any real SOW section or table cell) rather than tight, since the
// goal is a sane ceiling, not a workflow constraint.
export const MAX_SECTION_CONTENT_LENGTH = 50_000 // raw HTML chars, pre-sanitize
export const MAX_TABLE_CELL_LENGTH      = 2_000  // raw chars, pre-sanitize
export const MAX_TABLE_ROWS             = 200    // rows per table section

// Table rows are plain-text cells (rendered on the public portal page same
// as prose content) — sanitizePlainText, not sanitizeRichText, since a
// table cell was never meant to carry markup, only sanitized against
// injection. Unknown keys are dropped rather than passed through so a
// tampered PATCH body can't smuggle arbitrary fields into stored rows.
export function sanitizeTableRows(sectionId: string, rows: unknown): Array<Record<string, string>> {
  if (!isTableSection(sectionId) || !Array.isArray(rows)) return []
  const schema = SOW_TABLE_SCHEMAS[sectionId as SowTableSectionId]
  return rows.slice(0, MAX_TABLE_ROWS).map((row: any) => {
    const clean: Record<string, string> = {}
    for (const col of schema.columns)
      clean[col.key] = sanitizePlainText(String(row?.[col.key] ?? '').slice(0, MAX_TABLE_CELL_LENGTH))
    return clean
  })
}

// FIX (section-9 audit, 9-G10): 'parties', 'deliverables', 'payment' and
// 'signature' were the only sections the editor refused to let you hide.
// api/sow/generate hard-blocks generation outright when the workspace has
// no governing law set, on the explicit grounds that it is "a real,
// material legal term of the contract" — and then the agency could hide
// the entire Governing Law section from the document anyway. Out of Scope
// is the load-bearing section of a scope-governance product and was
// likewise optional. Both are required now. Kept in sync with
// REQUIRED_SECTIONS in components/sow/SowEditor.tsx.
export const REQUIRED_SECTION_IDS = ['parties', 'deliverables', 'oos', 'payment', 'governing_law', 'signature']

/**
 * FIX (section-9 audit, 9-G9): SOWs created before a section existed in
 * SOW_SECTION_DEFS simply don't have a row for it. That was a hard
 * dead-end for `payment_schedule`: api/sow/[id]/send refuses to send a
 * 'milestones' SOW without a footing payment schedule, SowEditor's nav
 * only renders ids present in the stored sections, and there is no
 * add-section action anywhere — so those SOWs were permanently
 * unsendable with no in-app way out. Fill any missing section in on read
 * so the editor can always show the full, current document shape.
 */
export function hydrateSections(stored: any[], metadata: any): any[] {
  const byId = new Map((stored || []).map((s: any) => [s.id, s]))
  const lang = metadata?.language
  return SOW_SECTION_DEFS.map(def => {
    const existing = byId.get(def.id)
    if (existing) {
      const hydrated: any = { ...existing, title: sectionTitle(def.id, lang), order: def.order }
      // `visible` is stored JSON — coerce anything that isn't a real boolean.
      if (typeof hydrated.visible !== 'boolean') hydrated.visible = true
      // FIX (re-audit, section 18 — flagship finding): re-sanitize on every read, the same
      // defense-in-depth the CO `note` and invoice `payment_instructions` fields already got in an
      // earlier round (see sanitizeRichTextOrNull at their portal GET routes) — "sanitize what
      // leaves the server, not just what enters it." This field never actually had that: the write
      // path (sanitizeSectionList, below) does sanitize, but nothing re-checked it on read, and this
      // is the one field of the three that reaches a public, unauthenticated page via
      // dangerouslySetInnerHTML (app/portal/sow/[token]/page.tsx, three times) with no second layer
      // of protection against a stray write that bypassed the app's own edit path (a direct
      // low-privilege API/PostgREST write, a future import, a pre-sanitization row). A comment on the
      // CO portal route and on the SOW portal page itself both asserted this protection already
      // existed here via hydrateSections — it didn't; this closes that gap for real.
      // Idempotent on already-sanitized content, so this is a no-op for the normal edit path.
      if (typeof hydrated.content === 'string') hydrated.content = sanitizeRichText(hydrated.content)
      // Table cells are plain text. Rows saved before sanitizePlainText stopped
      // HTML-escaping hold literal "&amp;" / "&lt;" — decode them on read so
      // old documents display (and print) correctly without a data migration.
      if (isTableSection(def.id)) {
        hydrated.table = (Array.isArray(existing.table) ? existing.table : []).map((row: any) => {
          const fixed: Record<string, string> = {}
          for (const [k, v] of Object.entries(row || {})) fixed[k] = typeof v === 'string' ? decodeHtmlEntities(v) : String(v ?? '')
          return fixed
        })
      }
      return hydrated
    }
    return {
      id: def.id,
      title: sectionTitle(def.id, lang),
      order: def.order,
      content: '',
      // Match the initial-visibility rule api/sow/generate applies.
      visible: def.id === 'payment_schedule' ? metadata?.paymentStructure === 'milestones' : true,
      ...(isTableSection(def.id) ? { table: [] } : {}),
    }
  })
}

export function sanitizeSectionList(incoming: unknown, stored: any[], metadata?: any): any[] {
  const submitted = new Map(
    (Array.isArray(incoming) ? incoming : [])
      .filter((s: any) => s && typeof s.id === 'string')
      .map((s: any) => [s.id, s])
  )
  const previous = new Map((stored || []).map((s: any) => [s.id, s]))

  return SOW_SECTION_DEFS.map(def => {
    const from = submitted.get(def.id) ?? previous.get(def.id) ?? {}
    const visible = REQUIRED_SECTION_IDS.includes(def.id)
      ? true
      : typeof from.visible === 'boolean' ? from.visible : true
    return {
      id:      def.id,
      title:   sectionTitle(def.id, metadata?.language),
      order:   def.order,
      content: sanitizeRichText(String(from.content ?? '').slice(0, MAX_SECTION_CONTENT_LENGTH)),
      visible,
      ...(isTableSection(def.id) ? { table: sanitizeTableRows(def.id, from.table) } : {}),
    }
  })
}

