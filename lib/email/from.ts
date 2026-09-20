// lib/email/from.ts
//
// FIX (Notifications & email fix round): the `From` header used to be built
// three different ways —
//   • templates.ts:  `${agencyName} via ScopeGov <${FROM}>` (FROM had a
//     fallback address),
//   • the SOW/CO remind routes: the same string but with
//     process.env.RESEND_FROM_EMAIL and NO fallback ("<undefined>" when the
//     env var is unset, while every templates.ts send kept working),
//   • request-changes: HTML-escaped the agency name into a header field
//     ("Smith &amp; Co via ScopeGov").
// `agency_name` is free text that only ever had control characters stripped,
// so a name such as `Smith, Jones & Co` or `Acme <Studios>` produced an
// RFC 5322 display name that isn't valid unquoted (comma / angle brackets).
// One helper now owns the header: display-name specials that can't be
// represented are removed, and the name is always sent as a quoted string.

export const DEFAULT_FROM_ADDRESS = 'noreply@mail.scopegov.app'

/** Sender address only (no display name). Read lazily so tests/env changes apply. */
export function fromAddress(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM_ADDRESS
}

/**
 * Make free text safe to use inside a quoted RFC 5322 display name:
 * control characters → space; `"`, `<`, `>` and `\` removed (they can't be
 * quoted portably and `<` / `>` would let a name smuggle in a second
 * address); whitespace collapsed.
 */
export function safeDisplayName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** `"Agency via ScopeGov" <noreply@…>` — for mail sent on an agency's behalf. */
export function formatFrom(agencyName?: string | null): string {
  const name = safeDisplayName(agencyName)
  return `"${name ? `${name} via ScopeGov` : 'ScopeGov'}" <${fromAddress()}>`
}

/** `"ScopeGov" <noreply@…>` — for system mail (security, billing, ops). */
export function systemFrom(label = 'ScopeGov'): string {
  return `"${safeDisplayName(label) || 'ScopeGov'}" <${fromAddress()}>`
}
