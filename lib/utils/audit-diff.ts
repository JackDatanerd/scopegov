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

const isBlank = (v: unknown) => v === null || v === undefined || v === ''

/** Equality for settings values: blank/null/undefined match, objects compare regardless of key order. */
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
