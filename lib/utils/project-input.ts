// Validation for the free-form fields of a project (create + edit).
//
// Projects & Dashboard deep audit: POST and PATCH validated different
// subsets, and PATCH validated almost nothing — whitespace-only names were
// stored, `NaN` contract values were sent to Postgres (JSON turns NaN into
// null → NOT NULL violation), negative contract values were accepted, and an
// unknown `type`/`stallReason` surfaced as a raw Postgres error. Both routes
// now share these parsers.

import type { ProjectType } from '@/lib/supabase/types'
import { roundCurrency } from '@/lib/utils/format'

export const PROJECT_TYPES: readonly ProjectType[] =
  ['web', 'mobile', 'brand', 'ecomm', 'marketing', 'retainer', 'video', 'other']

export const MAX_PROJECT_NAME = 200
export const MAX_PROJECT_DISC = 300
export const MAX_PROJECT_REF = 100
export const MAX_CONTRACT_VALUE = 1_000_000_000_000 // 1e12

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

export function parseProjectName(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string' || !raw.trim()) return fail('Project name is required')
  const v = raw.trim()
  if (v.length > MAX_PROJECT_NAME) return fail(`Project name must be ${MAX_PROJECT_NAME} characters or fewer`)
  return { ok: true, value: v }
}

/** Optional free text → trimmed string or null. */
export function parseOptionalText(raw: unknown, label: string, max: number): Parsed<string | null> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return fail(`${label} must be text`)
  const v = raw.trim()
  if (!v) return { ok: true, value: null }
  if (v.length > max) return fail(`${label} must be ${max} characters or fewer`)
  return { ok: true, value: v }
}

export function parseProjectType(raw: unknown): Parsed<ProjectType> {
  if (typeof raw !== 'string' || !(PROJECT_TYPES as readonly string[]).includes(raw))
    return fail('Unknown project type')
  return { ok: true, value: raw as ProjectType }
}

/** Accepts a number or a numeric string ("12,500.50"); rejects NaN/Infinity/negative/absurd. */
export function parseContractValue(raw: unknown): Parsed<number> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 0 }
  let n: number
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/,/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return fail('Contract value must be a number')
    n = Number(cleaned)
  } else return fail('Contract value must be a number')
  if (!Number.isFinite(n)) return fail('Contract value must be a number')
  if (n < 0) return fail('Contract value cannot be negative')
  if (n > MAX_CONTRACT_VALUE) return fail('Contract value is too large')
  return { ok: true, value: roundCurrency(n) }
}

export function parseCurrencyCode(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return fail('Currency must be a 3-letter code')
  const v = raw.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(v)) return fail('Currency must be a 3-letter code (e.g. USD)')
  return { ok: true, value: v }
}

/** YYYY-MM-DD that is a real calendar date, or null when empty. */
export function parseStartDate(raw: unknown): Parsed<string | null> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fail('Start date must be a valid date')
  const d = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return fail('Start date must be a valid date')
  return { ok: true, value: raw }
}

export function parseRetainerMonths(raw: unknown): Parsed<number | null> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 60) return fail('Retainer duration must be between 1 and 60 months')
  return { ok: true, value: n }
}
