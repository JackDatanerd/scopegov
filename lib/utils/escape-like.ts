// lib/utils/escape-like.ts
//
// FIX (independent pass round 2, section 14 — flagship finding): the same
// escapeLike() was hand-copied into four separate route files —
// app/api/clients/route.ts, app/api/clients/[id]/route.ts,
// app/api/clients/[id]/contacts/route.ts and
// app/api/clients/[id]/contacts/[contactId]/route.ts — each written as:
//   v.replace(/[\\%_]/g, m => `\${m}`)
// Inside a template literal, `\$` is an ESCAPED DOLLAR SIGN, not an escape
// character followed by an interpolation — so the replacement was always the
// literal 5-character string "${m}", never the matched character with a
// backslash in front of it. Concretely: escapeLike("jo_hn@x.com") produced
// "jo${m}hn@x.com", not "jo\_hn@x.com". Every ilike duplicate-email check
// this fed was therefore silently corrupted for any address containing '_'
// (an entirely ordinary character in an email local-part — first_last@…),
// '%', or '\' — the pattern sent to Postgres matched nothing real, so the
// friendly pre-insert "a client with this email already exists" check
// quietly turned into a no-op for exactly those addresses (masked for
// `clients` itself by its own DB-level unique index, but not for
// `client_contacts`, and even where masked it lost the friendly
// existingClientId/name payload the UI depends on to offer an "open it"
// link — see PATCH .../contacts and POST /api/clients for the full
// consequence). One correct implementation now, imported everywhere
// instead of re-typed a fifth time.
export function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, m => `\\${m}`)
}
