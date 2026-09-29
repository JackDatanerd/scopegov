// lib/utils/timestamps.ts

/**
 * True when two timestamp strings denote the same instant, whatever their textual form.
 *
 * Node's `toISOString()` yields "2026-01-01T00:00:00.155Z" while PostgREST returns the very same
 * stored value as "2026-01-01T00:00:00.155+00:00" (and can carry microseconds), so `===` on the
 * strings is never a reliable "has this row changed?" test. Unparseable input falls back to
 * strict string equality.
 */
export function sameInstant(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return a === b
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b
  return ta === tb
}
