// lib/audit/search.ts
//
// Builds the PostgREST `or=(...)` filter for the audit log free-text search.
//
// FIX (Reports & Audit re-pass #3): the old code backslash-escaped
// `, ( ) . " '` inside an UNQUOTED or() value. PostgREST does not treat
// backslash as an escape outside double quotes, so a search for
// "Acme, Inc" or "(draft)" produced a malformed filter — which the caller
// then swallowed, returning an empty table with no error. PostgREST's
// documented way to carry reserved characters in a value is to wrap it in
// double quotes (escaping only `"` and `\` inside them).
//
// Two escaping layers, applied in this order:
//   1. ILIKE layer: `\`, `%`, `_` are escaped with a backslash so the text
//      the user typed is matched literally (typing "50%" must not act as a
//      wildcard).
//   2. PostgREST quoted-string layer: `\` and `"` are backslash-escaped so
//      the value survives the quotes.

export const AUDIT_SEARCH_COLUMNS = ['event_type', 'entity_name', 'actor_name', 'actor_email', 'ip_address'] as const

export function escapeIlike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&')
}

export function quotePostgrestValue(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&')}"`
}

export const MAX_SEARCH_LENGTH = 100

export function buildAuditSearchFilter(rawQuery: string): string | null {
  const q = rawQuery.trim().slice(0, MAX_SEARCH_LENGTH)
  if (!q) return null
  const pattern = quotePostgrestValue(`%${escapeIlike(q)}%`)
  return AUDIT_SEARCH_COLUMNS.map(col => `${col}.ilike.${pattern}`).join(',')
}
