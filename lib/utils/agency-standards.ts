// lib/utils/agency-standards.ts
//
// An agency's standard SOW terms (revision-policy and payment-terms wording,
// standard exclusions and assumptions), stored on workspace_defaults and
// applied by the SOW generator. Limits here match what lib/ai/sow-content.ts
// keeps when it reads them back, so nothing a user saves is silently cut.

import { sanitizePlainText } from '@/lib/utils/sanitize'
import type { AgencyStandards } from '@/lib/ai/sow-content'

export const STANDARD_TEXT_MAX = 1500
export const CLAUSE_MAX = 500
export const CLAUSES_MAX = 30

export interface StandardsColumns {
  revision_policy?: string | null
  payment_terms?: string | null
  out_of_scope_clauses?: string[] | null
  assumptions?: string[] | null
}

export type StandardsParse =
  | { ok: true; values: StandardsColumns }
  | { ok: false; error: string }

// FIX (deep audit, Settings section — flagship finding): these used to
// collapse a blank string / empty list to `null` unconditionally — the same
// sentinel this whole subsystem (this file's own pickAgencyStandards, and
// workspace/defaults route.ts's GET `own()`) uses for "never touched, keep
// inheriting the workspace-wide value." That made "explicitly blank" and
// "not set" indistinguishable at the one place that could have told them
// apart: a project-type override deliberately cleared to have NO standard
// exclusions (say) could never actually record that — the moment it was
// saved, the empty submission collapsed to the same null that means
// "inherit," and pickAgencyStandards silently put the workspace-wide
// exclusions back into that project type's SOWs regardless, with the
// Settings UI still showing "this override applies" for whatever else on
// the same save WAS a genuine change. `null` alone remains the inherit
// sentinel (nothing in this codebase's UI ever submits a literal `null` for
// these fields — see the callers below and workspace/defaults route.ts's
// own inheritsFromGlobal collapse, which still stores null when a submitted
// value happens to match the workspace-wide one). A submitted '' or []
// is now preserved as a real, storable "explicitly nothing" value instead.
function parseText(value: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: `${label} must be text` }
  const clean = sanitizePlainText(value)
  if (clean.length > STANDARD_TEXT_MAX) return { ok: false, error: `${label} must be ${STANDARD_TEXT_MAX} characters or fewer` }
  return { ok: true, value: clean }
}

function parseClauses(value: unknown, label: string): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null }
  if (!Array.isArray(value)) return { ok: false, error: `${label} must be a list` }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, error: `${label} must be a list of text items` }
    const clean = sanitizePlainText(item)
    if (!clean) continue
    if (clean.length > CLAUSE_MAX) return { ok: false, error: `Each item in ${label} must be ${CLAUSE_MAX} characters or fewer` }
    out.push(clean)
  }
  if (out.length > CLAUSES_MAX) return { ok: false, error: `${label} can have at most ${CLAUSES_MAX} items` }
  return { ok: true, value: out }
}

/** Validate the standard-terms fields of a request body. Missing keys are left out (= unchanged). */
export function parseStandardsInput(body: Record<string, unknown>): StandardsParse {
  const values: StandardsColumns = {}

  if (body.revisionPolicy !== undefined) {
    const r = parseText(body.revisionPolicy, 'Revision policy')
    if (!r.ok) return r
    values.revision_policy = r.value
  }
  if (body.paymentTerms !== undefined) {
    const r = parseText(body.paymentTerms, 'Payment terms')
    if (!r.ok) return r
    values.payment_terms = r.value
  }
  if (body.outOfScopeClauses !== undefined) {
    const r = parseClauses(body.outOfScopeClauses, 'Standard exclusions')
    if (!r.ok) return r
    values.out_of_scope_clauses = r.value
  }
  if (body.assumptions !== undefined) {
    const r = parseClauses(body.assumptions, 'Standard assumptions')
    if (!r.ok) return r
    values.assumptions = r.value
  }
  return { ok: true, values }
}

const hasText = (v: unknown) => typeof v === 'string' && v.trim().length > 0
const hasList = (v: unknown) => Array.isArray(v) && v.length > 0

type DefaultsRow = StandardsColumns & { project_type?: string | null }

// A field the typed row never touched is stored as NULL (see
// workspace/defaults route.ts's inheritsFromGlobal) — that's the only case
// that should fall back to the workspace-wide value. A typed row that HAS a
// value, even '' or [], recorded a deliberate override and must be honoured
// as-is; treating it as "empty, so fall back" was the flagship bug this
// section's audit found (see parseText/parseClauses above for the write-side
// half of the same fix).
const isUnset = (v: unknown) => v === null || v === undefined

/**
 * The standards that apply to a project type: each field comes from that
 * type's own row when it has one, otherwise from the workspace-wide row. A
 * type override that only changes revision rounds therefore doesn't drop the
 * agency's standard exclusions for that type — but a type override that
 * deliberately blanks its exclusions no longer has the workspace-wide list
 * silently reinstated either.
 */
export function pickAgencyStandards(rows: DefaultsRow[] | null | undefined, projectType: string | null | undefined): AgencyStandards | null {
  const list = Array.isArray(rows) ? rows : []
  const typed = projectType ? list.find(r => r.project_type === projectType) : undefined
  const global = list.find(r => !r.project_type)
  if (!typed && !global) return null

  const revisionPolicy    = typed && !isUnset(typed.revision_policy)        ? typed.revision_policy        : (global?.revision_policy ?? null)
  const paymentTerms      = typed && !isUnset(typed.payment_terms)          ? typed.payment_terms          : (global?.payment_terms ?? null)
  const outOfScopeClauses = typed && !isUnset(typed.out_of_scope_clauses)   ? typed.out_of_scope_clauses   : (global?.out_of_scope_clauses ?? null)
  const assumptions       = typed && !isUnset(typed.assumptions)            ? typed.assumptions            : (global?.assumptions ?? null)

  if (!hasText(revisionPolicy) && !hasText(paymentTerms) && !hasList(outOfScopeClauses) && !hasList(assumptions)) return null
  return { revisionPolicy, paymentTerms, outOfScopeClauses, assumptions }
}
