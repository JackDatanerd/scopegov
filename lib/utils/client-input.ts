// lib/utils/client-input.ts
//
// FIX (independent pass, section 14): POST /api/clients and PATCH /api/clients/[id] each
// hand-validated a different subset of the body, and neither checked TYPES:
//   * a non-string name/email/phone (a number, null, an object) threw a TypeError → 500;
//   * clearing the name to '' wrote NULL into a NOT NULL column → a 500 carrying a raw DB error;
//   * an empty email on PATCH was silently ignored while the audit row claimed it was updated;
//   * billingAddress was stored as ANY json (any shape, any size) — and formatAddressLines()
//     calls .trim() on its parts, so one non-string value made every PDF, portal page and send
//     for that client throw;
//   * cc_emails had no cap and no de-duplication (and could repeat the primary address);
//   * timezone was any string, and nothing length-capped anything.
// One parser now serves both routes.

import { isValidTimeZone } from '@/lib/utils/timezone'

// FIX (independent pass 10, section 14 — B1): `[^\s@]` accepted a NUL byte, other control characters and lone UTF-16
// surrogates. Postgres cannot store \u0000 in text/jsonb and rejects an unpaired surrogate escape, so such an address
// passed validation and then failed inside the RPC as a generic 500. Control characters and lone surrogates are never
// part of a real address; the `u` flag makes `\ud800-\udfff` match ONLY unpaired surrogates (a valid pair is one code point).
// FIX (independent pass 11, section 14 — B3): the pattern accepted `a@x..com` (consecutive dots), a domain that starts or
// ends with a dot (`a@.x.com`, `a@x.com.`) and addresses carrying invisible format characters (zero-width space, soft
// hyphen, bidi marks, word joiner, BOM) that survive a copy-paste from a web page or PDF. Each passed create / edit /
// contact validation and then bounced (or failed in the mail provider) on the first send. ZWNJ/ZWJ are left alone — they
// are real characters in some scripts' domain names.
// FIX (independent pass 12, section 14 — B1): the pattern only excluded whitespace, `@`, control and invisible characters, so
// it accepted `jane@acme.com,` (a trailing comma pasted from a list), `<jane@acme.com>` (an address copied out of a mail
// header), `a,b@x.com`, `a;b@x.com`, `a@x.com>` and the quoted / bracketed forms (`"a b"@x.com`, `a@[1.2.3.4]`). Each passed
// validation, was stored as the client's primary address (or a contact / CC address) and bounced on the first send. The
// contact cards save from an onClick (not a <form> submit), so the browser's own type="email" check never ran for them.
// RFC 5322 specials that are never part of a deliverable address as people type it — `<>()[],;:"\` — are now excluded from
// both the local part and the domain. The apostrophe (o'brien@…) and `+` (jane+tag@…) stay valid, as do non-ASCII letters.
// FIX (independent pass 13, section 14 — B3): three more ways an address passed validation and then bounced on the first send.
//  (1) Invisible characters the earlier lists missed — the bidi isolates U+2066–2069 and the rest of the U+2060–206F format block,
//      the Arabic letter mark U+061C, the combining grapheme joiner U+034F, the Hangul / halfwidth-Hangul fillers (U+115F, U+1160,
//      U+3164, U+FFA0), the Mongolian variation selectors / vowel separator U+180B–180E, the emoji variation selectors U+FE00–FE0F,
//      the C1 controls U+0080–009F (U+0085 NEL), the interlinear-annotation / replacement characters, the blank braille cell and the
//      invisible \"tag\" characters U+E0000–E0FFF. All survive a copy-paste from a web page or PDF and are not part of a real address.
//      (ZWNJ/ZWJ U+200C/D are still allowed — they are real characters in some scripts' domain names.)
//  (2) Dot placement: only `..` was refused, so `.jane@acme.com` and `jane.@acme.com` passed (RFC 5321 forbids a local part that
//      starts or ends with a dot). The local part is now dot-separated non-empty atoms; the domain is dot-separated non-empty labels.
//  (3) Domain shape: a label that starts or ends with `-` (`jane@-acme.com`, `jane@acme-.com`), a one-character TLD (`jane@acme.c`)
//      and an all-digits TLD (`jane@acme.1`, and a bare IPv4 like `jane@1.2.3.4`) are never deliverable. A local part over 64 characters
//      (RFC 5321) is refused too. Written without a lookbehind on purpose: this module is also bundled for the browser, where an
//      unsupported lookbehind literal would throw at load time on older Safari.
const EMAIL_BAD = String.raw`\s@\u0000-\u001f\u007f-\u009f\ud800-\udfff\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffd\u{e0000}-\u{e0fff}<>()\[\],;:"\\`
const EMAIL_CHAR = String.raw`[^${EMAIL_BAD}.]`                       // any permitted character except the dot
// FIX (independent pass 14, section 14 — B4): `_` is a legal local-part character but is not valid in a
// hostname, so `a@exa_mple.com` passed validation and bounced on the first send. Domain labels use a
// stricter class that also excludes it (the local part keeps accepting it).
const DOMAIN_BAD = EMAIL_BAD + '_'
const DOMAIN_CHAR = String.raw`[^${DOMAIN_BAD}.]`
const EMAIL_LABEL = String.raw`[^${DOMAIN_BAD}.\-](?:${DOMAIN_CHAR}*[^${DOMAIN_BAD}.\-])?` // a domain label: no leading / trailing hyphen
// FIX (independent pass 15, section 14 — B1): every list above is a DENY list, and the domain's was still missing everything
// that is neither whitespace, a control / invisible character nor one of the RFC specials. So punctuation and symbols that
// ride along when an address is copied out of prose, a signature or a rich-text page passed validation and bounced on the
// first send: `jane@acme.com'` / `'jane@acme.com'`, `jane@acme.com…`, `“jane@acme.com”`, `jane@acme.com?subject=hi`,
// `jane@acme.com»`, `jane@ac!me.com`, `a@ex%ample.com`, `a@x.com/`, `a@x.com|`, `jane@acme.com€` and the like. A hostname is
// only ever letters, digits, marks and hyphens, so the domain now rejects any Unicode punctuation / symbol / other-category
// character except `.` `-` and (kept on purpose, see above) ZWNJ / ZWJ and the Catalan middle dot U+00B7. The local part keeps
// the ASCII `atext` specials (`+ ' * ! # $ % & / = ? ^ _ \` { | } ~ -`) but refuses NON-ASCII punctuation / symbols — a curly
// quote or ellipsis there is a paste artefact (`“jane@acme.com`), never a typed address. Both are lookaheads over `[^@]*`, so
// the pattern stays linear-time on hostile input (covered by the pass 14 timing test, repeated for pass 15).
const NON_ASCII_JUNK = String.raw`(?![\u0000-\u007f\u00b7\u200c\u200d])[\p{P}\p{S}\p{C}]`   // non-ASCII punctuation / symbol / other
const DOMAIN_JUNK    = String.raw`(?![.\-\u00b7\u200c\u200d])[\p{P}\p{S}\p{C}]`            // anything but . - and the kept joiners
export const EMAIL_RE = new RegExp(
  String.raw`^(?=[^@]{1,64}@)(?![^@]*${NON_ASCII_JUNK})${EMAIL_CHAR}+(?:\.${EMAIL_CHAR}+)*@(?![^@]*${DOMAIN_JUNK})(?:${EMAIL_LABEL}\.)+(?![0-9]+$)(?=${DOMAIN_CHAR}{2})${EMAIL_LABEL}$`,
  'u',
)

/** True when the text holds a NUL byte or an unpaired surrogate — values Postgres refuses to store. */
export function hasUnstorableText(s: string): boolean {
  return /[\u0000\ud800-\udfff]/u.test(s)
}
export const UNSTORABLE_TEXT_ERROR = (label: string) => `${label} contains characters that can’t be saved`
export const MAX_CC_EMAILS = 10

export const CLIENT_LIMITS = {
  name: 200, companyName: 200, email: 254, phone: 50, notes: 5000,
  vatNumber: 50, paymentTermsNote: 1000, addressPart: 200, contactRole: 100,
} as const

export const CONTACT_ROLE_TYPES = ['billing', 'scope', 'approver', 'other'] as const
export type ContactRoleType = typeof CONTACT_ROLE_TYPES[number]

export interface NormalizedBillingAddress {
  line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string
}
const ADDRESS_KEYS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const

export type ParsedClientInput =
  | { ok: true; updates: Record<string, unknown> }
  | { ok: false; error: string }

const fail = (error: string): ParsedClientInput => ({ ok: false, error })

/** null → null; '' / whitespace → null; non-string → error; over-long → error. */
function optionalText(v: unknown, label: string, max: number): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false, error: `${label} must be text` }
  const t = v.trim()
  if (hasUnstorableText(t)) return { ok: false, error: UNSTORABLE_TEXT_ERROR(label) }
  if (t.length > max) return { ok: false, error: `${label} is too long (${max} characters max)` }
  return { ok: true, value: t || null }
}

// FIX (independent pass, section 14 — B4): the address is replaced as a whole, so the edit card has to send every part
// whenever any one changed. A legacy row (stored before these limits existed) with an over-long part then failed a save
// that only touched a different part, with an error about a field the person never edited. A part that is byte-for-byte
// what is already stored is accepted as-is — the cap applies to what the person writes, not to what is already there.
export function normalizeBillingAddress(
  v: unknown, existing?: unknown,
): { ok: true; value: NormalizedBillingAddress | null } | { ok: false; error: string } {
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'Billing address must be an object' }
  const out: NormalizedBillingAddress = {}
  for (const key of ADDRESS_KEYS) {
    const raw = (v as any)[key]
    if (raw === undefined || raw === null || raw === '') continue
    if (typeof raw !== 'string') return { ok: false, error: `Billing address ${key} must be text` }
    const t = raw.trim()
    if (hasUnstorableText(t)) return { ok: false, error: UNSTORABLE_TEXT_ERROR(`Billing address ${key}`) }
    const unchanged = !!existing && typeof existing === 'object' && !Array.isArray(existing)
      && typeof (existing as any)[key] === 'string' && (existing as any)[key].trim() === t
    if (t.length > CLIENT_LIMITS.addressPart && !unchanged) return { ok: false, error: `Billing address ${key} is too long (${CLIENT_LIMITS.addressPart} characters max)` }
    if (t) out[key] = t
  }
  // An all-empty address is "no address" — store NULL, not {line1:'', …}.
  return { ok: true, value: Object.keys(out).length ? out : null }
}

export function normalizeCcEmails(v: unknown, primaryEmail?: string | null): { ok: true; value: string[] } | { ok: false; error: string } {
  if (v === null || v === undefined || v === '') return { ok: true, value: [] }
  let raw: unknown[]
  if (Array.isArray(v)) raw = v
  else if (typeof v === 'string') raw = v.split(/[,\n;]/)
  else return { ok: false, error: 'CC emails must be a list of addresses' }
  const seen = new Set<string>()
  const primary = (primaryEmail || '').toLowerCase()
  for (const e of raw) {
    if (typeof e !== 'string') return { ok: false, error: 'CC emails must be a list of addresses' }
    const t = e.trim().toLowerCase()
    if (!t) continue
    if (t.length > CLIENT_LIMITS.email || !EMAIL_RE.test(t)) return { ok: false, error: `Invalid CC email address: ${t.slice(0, 80)}` }
    if (t === primary) continue // already the To: recipient
    seen.add(t)
  }
  if (seen.size > MAX_CC_EMAILS) return { ok: false, error: `At most ${MAX_CC_EMAILS} CC addresses are allowed` }
  return { ok: true, value: Array.from(seen) }
}

export function parseClientInput(
  body: any,
  mode: 'create' | 'update',
  ctx: { currentEmail?: string | null; currentBillingAddress?: unknown } = {},
): ParsedClientInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid request body')
  const updates: Record<string, unknown> = {}

  // name — required, never blank
  if (mode === 'create' || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return fail('Name is required')
    if (hasUnstorableText(body.name)) return fail(UNSTORABLE_TEXT_ERROR('Name'))
    if (body.name.trim().length > CLIENT_LIMITS.name) return fail(`Name is too long (${CLIENT_LIMITS.name} characters max)`)
    updates.name = body.name.trim()
  }

  // email — required on create; on update, present means valid (an empty string is an error, not a no-op)
  let effectiveEmail: string | null = ctx.currentEmail ?? null
  if (mode === 'create' || body.email !== undefined) {
    if (typeof body.email !== 'string' || !body.email.trim()) return fail(mode === 'create' ? 'Name and email required' : 'Email can’t be empty')
    const e = body.email.trim().toLowerCase()
    if (e.length > CLIENT_LIMITS.email || !EMAIL_RE.test(e)) return fail('Please enter a valid email address')
    updates.email = e
    effectiveEmail = e
  }

  const textFields: Array<[string, string, string, number]> = [
    ['companyName', 'company_name', 'Company name', CLIENT_LIMITS.companyName],
    ['phone', 'phone', 'Phone', CLIENT_LIMITS.phone],
    ['notes', 'notes', 'Notes', CLIENT_LIMITS.notes],
    ['vatNumber', 'vat_number', 'VAT number', CLIENT_LIMITS.vatNumber],
    ['paymentTermsNote', 'payment_terms_note', 'Payment terms note', CLIENT_LIMITS.paymentTermsNote],
  ]
  for (const [key, col, label, max] of textFields) {
    if (body[key] === undefined) continue
    const r = optionalText(body[key], label, max)
    if (!r.ok) return fail(r.error)
    updates[col] = r.value
  }

  if (body.timezone !== undefined) {
    if (body.timezone === null || body.timezone === '') updates.timezone = null
    else if (typeof body.timezone !== 'string' || !isValidTimeZone(body.timezone.trim()))
      return fail('Timezone must be a valid IANA timezone, e.g. Africa/Nairobi')
    else updates.timezone = body.timezone.trim()
  }

  if (body.billingAddress !== undefined) {
    const r = normalizeBillingAddress(body.billingAddress, ctx.currentBillingAddress)
    if (!r.ok) return fail(r.error)
    updates.billing_address = r.value
  }

  // CC list is normalised against the EFFECTIVE primary address (so it never repeats it) — and
  // re-normalised whenever the primary changes, so an address that has just become the primary
  // drops out of the CC list.
  if (body.ccEmails !== undefined) {
    const r = normalizeCcEmails(body.ccEmails, effectiveEmail)
    if (!r.ok) return fail(r.error)
    updates.cc_emails = r.value
  }

  return { ok: true, updates }
}
