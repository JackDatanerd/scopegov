// lib/utils/audit-diff.ts
//
// Builds the `changes` block for audit metadata: which fields actually
// changed, and from what to what. Values are length-capped, and fields listed
// in `redact` record only that they changed (never the value) — used for
// things like tax ids and payment instructions that shouldn't be readable by
// everyone who holds VIEW_AUDIT_LOG or exported to CSV/PDF.

export type FieldChange = { from: unknown; to: unknown } | { changed: true }

const MAX_VALUE_CHARS = 200

function clip(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value
  }
  if (value !== null && typeof value === 'object') {
    const json = JSON.stringify(value)
    return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}…` : value
  }
  return value
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

// FIX (deep audit, Settings re-pass — HIGH): a workspace whose legal_address
// had never been set stored NULL (no DB default — see migration 011). The
// client always sends a fully-shaped baseline object for it (cleanAddress()
// on an empty form produces `{}`, never `null`). isBlank() didn't consider
// `{}`/`[]` blank, so sameValue({}, null) was false, so *any* edit to
// legalAddress on a workspace that had never saved one tripped the
// optimistic-concurrency check in PATCH /api/workspace/settings and was
// rejected as "changed by someone else" — a conflict that was never real,
// and that reloading the page could never clear, because the reload would
// hand back the same NULL/`{}` pair. Structurally-empty values (`{}`, `[]`)
// now count as blank alongside null/undefined/'', so they compare equal to
// each other and to null. This is the same fix in spirit as the existing
// null/undefined/'' equivalence just above: none of these carry information,
// so none of them should read as a "change" against each other, either in
// the audit diff or in the conflict check that reuses this same function.
const isEmptyStructure = (v: unknown): boolean =>
  (Array.isArray(v) && v.length === 0) ||
  (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as Record<string, unknown>).length === 0)

const isBlank = (v: unknown) => v === null || v === undefined || v === '' || isEmptyStructure(v)

/** Equality for settings values: blank/null/undefined/empty-object/empty-array match, objects compare regardless of key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (isBlank(a) && isBlank(b)) return true
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null)) } catch { return false }
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return false
}

export interface DiffResult {
  /** Keys (as named in `keys`) whose value differs. */
  changedKeys: string[]
  /** Per-key from/to (or just `{ changed: true }` for redacted keys). */
  changes: Record<string, FieldChange>
}

/**
 * @param before  current values, keyed the same as `after`
 * @param after   proposed values (only keys being written)
 * @param redact  keys whose values must not be recorded
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  redact: readonly string[] = [],
): DiffResult {
  const changedKeys: string[] = []
  const changes: Record<string, FieldChange> = {}
  for (const key of Object.keys(after)) {
    if (sameValue(before[key], after[key])) continue
    changedKeys.push(key)
    changes[key] = redact.includes(key)
      ? { changed: true }
      : { from: clip(before[key] ?? null), to: clip(after[key] ?? null) }
  }
  return { changedKeys, changes }
}
