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
import { SOW_TABLE_SCHEMAS, type SowTableSectionId, type SowTableRow } from '@/lib/sow/table-schema'

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
  { id: 'revisions',       title: 'Revision Policy',             order: 9 },
  { id: 'ip',              title: 'Intellectual Property',       order: 10 },
  { id: 'confidentiality', title: 'Confidentiality',             order: 11 },
  { id: 'termination',     title: 'Termination',                 order: 12 },
  { id: 'governing_law',   title: 'Governing Law',               order: 13 },
  { id: 'dispute',         title: 'Dispute Resolution',          order: 14 },
  { id: 'signature',       title: 'Signatures',                  order: 15 },
]

// Table-driven sections (defined in lib/sow/table-schema.ts) — never
// asked of the model as prose.
const TABLE_IDS: SowTableSectionId[] = ['deliverables', 'timeline', 'roles']

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
  revisionRounds: number
  governingLaw: string
}

// ── 1. Boilerplate sections — deterministic, never asked of the model ──

export function buildBoilerplateSections(input: SowContentInput): Record<string, string> {
  const agency = escapeHtml(input.agencyName)
  const client = escapeHtml(input.clientName)
  const law    = escapeHtml(input.governingLaw)
  return {
    parties: `<p>This Statement of Work is entered into between <strong>${agency}</strong> ("Agency") and <strong>${client}</strong> ("Client").</p>`,
    governing_law: `<p>This Agreement is governed by the laws of ${law}.</p>`,
    signature: `<p>By signing below, both parties agree to the terms of this Statement of Work.</p>`,
  }
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

Then produce THREE tables. For each, write the table marker line exactly as shown, then one row per line in the exact pipe-delimited column order given, then a line with exactly ${TABLE_END}. Do not include the column header row itself. 3-6 rows per table is typical; use your judgement based on the brief.

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
${TABLE_END}

Do not add any other commentary before, between, or after sections/tables.

Rules:
- Every prose section's content must be proper HTML (use <p>, <ul>, <li>, <strong>). No raw text outside tags.
- Payment section must state exactly "${input.currency} ${input.contractValue}" and the exact payment structure above. Do NOT invent percentages or amounts beyond what's stated.
- Out of scope section must list every item from the out-of-scope brief as explicit exclusions. Be specific.
- Revision policy must reference exactly ${input.revisionRounds} revision round(s).
- Deliverables table rows must cover every item in the deliverables brief above — one row per deliverable, not grouped.
- Roles table must reflect that ${input.agencyName} is the Provider and ${input.clientName} is the Client.
- Write with professional, authoritative language appropriate for a legal document.
- Never add a "late fee rate" or "revision fee" unless explicitly provided.${reminder}`
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
  for (let i = 1; i < parts.length; i += 2) {
    const id      = parts[i]?.trim()
    const content = (parts[i + 1] || '').trim()
    if (id) sections[id] = content
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
export function parseTableSections(raw: string): Record<SowTableSectionId, SowTableRow[]> {
  const result: Record<SowTableSectionId, SowTableRow[]> = { deliverables: [], timeline: [], roles: [] }

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
          // Model drifted from the exact enum — best-effort normalize, else drop to last option
          const found = col.options.find(o => value.toLowerCase().startsWith(o.toLowerCase()[0]))
          value = found || col.options[col.options.length - 1]
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

export function buildFallbackSections(input: SowContentInput): Record<string, string> {
  const outOfScopeItems = (input.outOfScope || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => `<li>${escapeHtml(l.replace(/^[-*]\s*/, ''))}</li>`).join('')

  return {
    overview: `<p>${escapeHtml((input.objective || '').trim() || `${input.agencyName} will deliver a ${input.projectType} project for ${input.clientName} as described in the accompanying brief.`)}</p>`,
    oos: outOfScopeItems
      ? `<p>The following are explicitly excluded from this engagement:</p><ul>${outOfScopeItems}</ul>`
      : `<p>Any work not explicitly listed under Deliverables above is considered out of scope and will require a separate Change Order.</p>`,
    assumptions: `<p>This Statement of Work assumes timely feedback, approvals, and provision of any required materials or access from the Client. Delays in Client responsiveness may affect the timeline above.</p>`,
    payment: `<p>Total contract value: <strong>${escapeHtml(String(input.currency))} ${escapeHtml(String(input.contractValue))}</strong>. Payment structure: ${escapeHtml(input.paymentLabel)}.</p>`,
    revisions: `<p>This engagement includes ${input.revisionRounds} round${input.revisionRounds === 1 ? '' : 's'} of revisions per deliverable. Additional revision rounds beyond this may be billed separately or handled via a Change Order.</p>`,
    ip: `<p>Upon receipt of full payment, all final deliverables become the property of the Client. ${escapeHtml(input.agencyName)} retains the right to display the work in its portfolio unless otherwise agreed in writing.</p>`,
    confidentiality: `<p>Both parties agree to keep confidential any proprietary or non-public information shared during the course of this engagement.</p>`,
    termination: `<p>Either party may terminate this engagement with written notice. Client will be billed for all work completed up to the date of termination.</p>`,
    dispute: `<p>Any disputes arising from this Statement of Work will first be addressed through good-faith negotiation between the parties before pursuing formal resolution under the governing law stated below.</p>`,
  }
}

/** Deterministic table fallback — same guarantee as buildFallbackSections: always produces at least one usable row per table from whatever the brief contains, never blocks document generation. */
export function buildFallbackTables(input: SowContentInput): Record<SowTableSectionId, SowTableRow[]> {
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
  const deliverableLines = ((input.deliverables || '').trim() || 'Project deliverable as discussed with the Agency')
    .split('\n').map(l => l.trim().replace(/^[-*]\s*/, '')).filter(Boolean)

  const timelineLines = ((input.timeline || '').trim() || 'Delivery')
    .split('\n').map(l => l.trim().replace(/^[-*]\s*/, '')).filter(Boolean)

  return {
    deliverables: deliverableLines.map(d => ({
      deliverable: sanitizePlainText(d),
      acceptanceCriteria: 'Reviewed and approved by Client',
      owner: 'Provider',
      targetDate: 'To be confirmed',
    })),
    timeline: timelineLines.map((t, i) => ({
      phase: `Phase ${i + 1}`,
      description: sanitizePlainText(t),
      duration: 'To be confirmed',
    })),
    roles: [
      { responsibility: 'Delivery of contracted work', provider: '✓', client: '—', notes: '' },
      { responsibility: 'Timely feedback and approvals', provider: '—', client: '✓', notes: '' },
      { responsibility: 'Provision of required materials and access', provider: '—', client: '✓', notes: '' },
      { responsibility: 'Payment per the schedule below', provider: '—', client: '✓', notes: '' },
    ],
  }
}
