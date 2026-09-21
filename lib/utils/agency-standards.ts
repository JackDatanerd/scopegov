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

function parseText(value: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === '') return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: `${label} must be text` }
  const clean = sanitizePlainText(value)
  if (clean.length > STANDARD_TEXT_MAX) return { ok: false, error: `${label} must be ${STANDARD_TEXT_MAX} characters or fewer` }
  return { ok: true, value: clean || null }
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
  return { ok: true, value: out.length ? out : null }
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

/**
 * The standards that apply to a project type: each field comes from that
 * type's own row when it has one, otherwise from the workspace-wide row. A
 * type override that only changes revision rounds therefore doesn't drop the
 * agency's standard exclusions for that type.
 */
export function pickAgencyStandards(rows: DefaultsRow[] | null | undefined, projectType: string | null | undefined): AgencyStandards | null {
  const list = Array.isArray(rows) ? rows : []
  const typed = projectType ? list.find(r => r.project_type === projectType) : undefined
  const global = list.find(r => !r.project_type)
  if (!typed && !global) return null

  const revisionPolicy    = hasText(typed?.revision_policy) ? typed!.revision_policy : (global?.revision_policy ?? null)
  const paymentTerms      = hasText(typed?.payment_terms) ? typed!.payment_terms : (global?.payment_terms ?? null)
  const outOfScopeClauses = hasList(typed?.out_of_scope_clauses) ? typed!.out_of_scope_clauses : (global?.out_of_scope_clauses ?? null)
  const assumptions       = hasList(typed?.assumptions) ? typed!.assumptions : (global?.assumptions ?? null)

  if (!hasText(revisionPolicy) && !hasText(paymentTerms) && !hasList(outOfScopeClauses) && !hasList(assumptions)) return null
  return { revisionPolicy, paymentTerms, outOfScopeClauses, assumptions }
}
