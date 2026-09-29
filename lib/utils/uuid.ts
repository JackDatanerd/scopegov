// lib/utils/uuid.ts
//
// FIX (independent pass 1, section 14 — B3): a route/page id that isn't a UUID (a mistyped or truncated
// URL, a probe) reaches Postgres as `uuid = 'abc'`, which raises 22P02 ("invalid input syntax for type
// uuid"). Every Clients read treats any error other than "no row" as an outage and throws, so a garbage id
// came back as a 500 / the error boundary instead of a 404. Callers check this BEFORE querying.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuidString(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}
