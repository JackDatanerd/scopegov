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
//  2. Three of the fourteen sections (parties / governing_law / signature)
//     were already fully hardcoded boilerplate in the old prompt's JSON
//     template — the model was never actually asked to draft them. That
//     didn't change; it's just built here in code now instead of being
//     smuggled into a "one shot" prompt.
//  3. If the model's output still doesn't parse after a couple of quick,
//     silent retries, `buildFallbackSections()` produces a complete,
//     usable SOW directly from the brief fields with zero AI involvement
//     — guaranteed to succeed. The Generate SOW button must never be able
//     to hard-fail the user; AI makes the result better, it doesn't gate
//     whether a result exists. Per-section AI polish afterward
//     (sow/regenerate-section) is the place to retry quality, not this
//     endpoint.

import { escapeHtml } from '@/lib/utils/sanitize'

export interface SowSectionDef { id: string; title: string; order: number }

// Full, server-owned section list — the only place this ordering is
// defined. Nothing about it is ever requested from the model.
export const SOW_SECTION_DEFS: SowSectionDef[] = [
  { id: 'parties',         title: 'Parties',                    order: 1 },
  { id: 'overview',        title: 'Project Overview',           order: 2 },
  { id: 'deliverables',    title: 'Deliverables',                order: 3 },
  { id: 'oos',             title: 'Out of Scope',                order: 4 },
  { id: 'assumptions',     title: 'Assumptions & Dependencies',  order: 5 },
  { id: 'timeline',        title: 'Timeline & Milestones',       order: 6 },
  { id: 'payment',         title: 'Payment Terms',               order: 7 },
  { id: 'revisions',       title: 'Revision Policy',             order: 8 },
  { id: 'ip',              title: 'Intellectual Property',       order: 9 },
  { id: 'confidentiality', title: 'Confidentiality',             order: 10 },
  { id: 'termination',     title: 'Termination',                 order: 11 },
  { id: 'governing_law',   title: 'Governing Law',               order: 12 },
  { id: 'dispute',         title: 'Dispute Resolution',          order: 13 },
  { id: 'signature',       title: 'Signatures',                  order: 14 },
]

// The subset that actually needs drafted prose. parties/governing_law/
// signature are pure boilerplate — see buildBoilerplateSections below.
export const AI_SECTION_IDS = SOW_SECTION_DEFS
  .map(s => s.id)
  .filter(id => !['parties', 'governing_law', 'signature'].includes(id))

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

export function buildSowContentPrompt(input: SowContentInput, opts?: { emphatic?: boolean }): string {
  const markerList = AI_SECTION_IDS.map(id => SECTION_MARKER(id)).join('\n')
  const reminder = opts?.emphatic
    ? `\n\nIMPORTANT — your previous attempt did not use the required format correctly. You MUST start every section with its exact marker line, e.g. ${SECTION_MARKER('overview')}, on its own line, with nothing else on that line. Do not use JSON, do not use markdown code fences, do not skip any marker.`
    : ''

  return `You are a professional contract drafter for a creative/digital agency.
Draft the prose content for a Statement of Work. Use ONLY the exact figures provided below. Never invent payment amounts, fees, rates, or revision counts.

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

Output format — this is plain text, NOT JSON. For each of the following ${AI_SECTION_IDS.length} sections, write a marker line exactly as shown, then the section's HTML content on the following line(s), then move straight to the next marker. Do not wrap anything in markdown code fences. Do not add any other commentary before, between, or after sections.

${markerList}

Rules:
- Every section's content must be proper HTML (use <p>, <ul>, <li>, <strong>). No raw text outside tags.
- Payment section must state exactly "${input.currency} ${input.contractValue}" and the exact payment structure above. Do NOT invent percentages or amounts beyond what's stated.
- Out of scope section must list every item from the out-of-scope brief as explicit exclusions. Be specific.
- Revision policy must reference exactly ${input.revisionRounds} revision round(s).
- Write with professional, authoritative language appropriate for a legal document.
- Never add a "late fee rate" or "revision fee" unless explicitly provided.${reminder}`
}

// ── 3. Parser — tolerant of anything except the markers themselves ─────

export class SowContentParseError extends Error {
  constructor(public missingOrEmpty: string[]) {
    super(`Missing or empty sections: ${missingOrEmpty.join(', ')}`)
  }
}

export function parseDelimitedSections(raw: string): Record<string, string> {
  // Split on marker lines, keeping the captured id. This succeeds even if
  // the model added a stray preamble sentence or wrapped the whole thing
  // in a code fence — we only care that the markers themselves are intact,
  // not that the surrounding text is "clean".
  const parts = raw.split(/<<<SECTION:([a-z_]+)>>>/)
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

// ── 4. Deterministic fallback — guaranteed to succeed, no AI involved ──
// Used only if every AI attempt fails to parse. Plainer language than the
// AI-drafted version, but a complete, legally-structured, usable SOW —
// the user is never blocked from generating a document.

export function buildFallbackSections(input: SowContentInput): Record<string, string> {
  const deliverableItems = (input.deliverables || 'As discussed with the Agency')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => `<li>${escapeHtml(l.replace(/^[-*]\s*/, ''))}</li>`).join('')
  const outOfScopeItems = (input.outOfScope || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => `<li>${escapeHtml(l.replace(/^[-*]\s*/, ''))}</li>`).join('')

  return {
    overview: `<p>${escapeHtml(input.objective || `${input.agencyName} will deliver a ${input.projectType} project for ${input.clientName} as described in the accompanying brief.`)}</p>`,
    deliverables: `<ul>${deliverableItems}</ul>`,
    oos: outOfScopeItems
      ? `<p>The following are explicitly excluded from this engagement:</p><ul>${outOfScopeItems}</ul>`
      : `<p>Any work not explicitly listed under Deliverables above is considered out of scope and will require a separate Change Order.</p>`,
    assumptions: `<p>This Statement of Work assumes timely feedback, approvals, and provision of any required materials or access from the Client. Delays in Client responsiveness may affect the timeline below.</p>`,
    timeline: `<p>${escapeHtml(input.timeline || 'The estimated timeline for this engagement will be confirmed upon kickoff.')}</p>`,
    payment: `<p>Total contract value: <strong>${escapeHtml(String(input.currency))} ${escapeHtml(String(input.contractValue))}</strong>. Payment structure: ${escapeHtml(input.paymentLabel)}.</p>`,
    revisions: `<p>This engagement includes ${input.revisionRounds} round${input.revisionRounds === 1 ? '' : 's'} of revisions per deliverable. Additional revision rounds beyond this may be billed separately or handled via a Change Order.</p>`,
    ip: `<p>Upon receipt of full payment, all final deliverables become the property of the Client. ${escapeHtml(input.agencyName)} retains the right to display the work in its portfolio unless otherwise agreed in writing.</p>`,
    confidentiality: `<p>Both parties agree to keep confidential any proprietary or non-public information shared during the course of this engagement.</p>`,
    termination: `<p>Either party may terminate this engagement with written notice. Client will be billed for all work completed up to the date of termination.</p>`,
    dispute: `<p>Any disputes arising from this Statement of Work will first be addressed through good-faith negotiation between the parties before pursuing formal resolution under the governing law stated below.</p>`,
  }
}
