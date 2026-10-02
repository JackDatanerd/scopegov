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
//
// FIX (independent pass 13, section 14 — B1): that fix still missed one metacharacter. PostgREST treats `*` in a
// like/ilike value as an alias for `%` and offers NO way to escape it (lib/search/query.ts strips it for exactly that
// reason) — yet `*` is a legal email local-part character that EMAIL_RE accepts. escapeLike("a*@x.com") therefore
// still matched "ab@x.com", "abc@x.com" … so adding a contact `a*@x.com` was refused as a duplicate of an unrelated
// contact, and the project-creation / Guardian-inbound lookups could resolve a DIFFERENT client or contact. A `*` is
// now turned into `_` (a single-character wildcard, which still matches a literal `*`), so a pattern can never match
// MORE than its literal self plus single-character look-alikes. That remaining over-match is why every caller must
// confirm an exact, case-insensitive equality on the returned rows with sameEmail() — or, where the candidate set is
// small and bounded (a client's <= 25 contacts), skip LIKE altogether and compare in code.
export function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, m => `\\${m}`).replace(/\*/g, '_')
}

/** Exact, case-insensitive email equality (the check LIKE patterns can only approximate). */
export function sameEmail(a: unknown, b: unknown): boolean {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
}
