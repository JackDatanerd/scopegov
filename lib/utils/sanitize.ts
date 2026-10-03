// lib/utils/sanitize.ts
//
// FIX (audit round 1, item #2): SOW section content (PATCH /api/sow/[id])
// and CO notes (POST/PATCH /api/co) were stored verbatim from the request
// body with no HTML sanitization anywhere in the pipeline, then rendered
// with dangerouslySetInnerHTML on PUBLIC, UNAUTHENTICATED portal pages
// (app/portal/sow/[token]/page.tsx, app/portal/co/[token]/page.tsx). Any
// workspace member (or an attacker who compromises one such account) could
// call the API directly — bypassing the TipTap editor's own tag
// constraints entirely — and plant a stored XSS payload that executes in
// every client's browser when they open the signing link.
//
// Sanitize at the write boundary (belt) so nothing unsafe ever reaches the
// database, matching the actual rich-text surface TipTap's StarterKit
// exposes (bold/italic/lists/paragraphs/headings/links) — not a general
// "allow most things" policy.

import sanitizeHtml from 'sanitize-html'

const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'strike',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'a', 'code', 'pre',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  // Only allow safe link schemes — blocks javascript:, data:, vbscript:, etc.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    // Force-add rel="noopener noreferrer" and safe target on any link so a
    // sanitized-but-still-user-authored href can't be used for tabnabbing.
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
}

/** Sanitize rich-text HTML (SOW section content) before it's stored. */
export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return ''
  return sanitizeHtml(html, RICH_TEXT_OPTIONS)
}

/**
 * Same as sanitizeRichText, but returns null for "empty" rich text —
 * Tiptap emits `<p></p>` for a cleared editor, not an empty string, so a
 * naive `html ? sanitizeRichText(html) : null` check treats a blank field
 * as present content and renders an empty box on the document. Strips
 * tags to check for actual remaining text before deciding.
 */
export function sanitizeRichTextOrNull(html: string | null | undefined): string | null {
  const clean = sanitizeRichText(html)
  return clean.replace(/<[^>]+>/g, '').trim() ? clean : null
}

/**
 * Decode the small set of HTML entities sanitize-html (and TipTap) emit.
 * `&amp;` is decoded LAST so `&amp;lt;` becomes the literal text `&lt;`, not `<`.
 */
export function decodeHtmlEntities(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Strip ALL markup and return PLAIN TEXT.
 *
 * sanitize-html always returns an HTML-escaped string (`Tom & Jerry` comes back as
 * `Tom &amp; Jerry`). That is correct for HTML output but wrong for a plain-text
 * field: React, react-pdf and the audit/notification tables all print the string
 * verbatim, so every ampersand or angle bracket showed up as a literal entity, and
 * the outbound emails (which call escapeHtml themselves) escaped it a second time.
 * We therefore decode after stripping. The result contains no tags (they were
 * removed before decoding); every sink for these fields escapes on output
 * (React text nodes, react-pdf <Text>, escapeHtml in the email templates) — none
 * of them is a dangerouslySetInnerHTML sink. Rich-text fields use sanitizeRichText.
 */
export function sanitizePlainText(text: string | null | undefined): string {
  if (!text) return ''
  const stripped = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} })
  return decodeHtmlEntities(stripped).trim()
}

/**
 * Cut `text` to at most `maxLength` UTF-16 code units WITHOUT splitting a surrogate pair.
 *
 * `String.prototype.slice` counts UTF-16 units, so a cap that lands in the middle of an emoji (or any
 * character outside the BMP) leaves a lone high surrogate at the end. That string is not valid Unicode: the
 * JSON body sent to Postgres is rejected, the whole write fails, and the user just sees a generic
 * "could not save" for a title or note that looked fine. (sanitizeDisplayName below already guards this for
 * names; every other capped free-text field needs the same treatment, so they share this.)
 */
export function truncateText(text: string | null | undefined, maxLength: number): string {
  if (!text || maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  let end = maxLength
  const last = text.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1 // the cut would strand the first half of a pair
  return text.slice(0, end)
}

/**
 * Remove what Postgres cannot store in text/jsonb: NUL (U+0000) is deleted and an unpaired surrogate (half an
 * emoji) becomes U+FFFD. Valid surrogate pairs are untouched. Guardian text arrives from outside the app (inbound
 * email bodies, pasted client messages) and a single such character fails the whole insert with a generic 500 -
 * for an inbound email Postmark then redelivers into the same failure and the request is never recorded.
 */
export function stripUnstorableText(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

/**
 * Validate + clean an untrusted free-text request field: returns '' for a
 * missing value, null when the value is present but not a string (so the caller
 * can answer 400 instead of crashing on `.trim()`), otherwise the sanitized,
 * length-capped plain text.
 */
export function cleanTextField(value: unknown, maxLen: number): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  return truncateText(sanitizePlainText(value), maxLen)
}

/** Escape text for safe interpolation into an HTML email body (outbound notification emails, not stored). */
export function escapeHtml(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// FIX (re-audit, notifications section): workspaces.agency_name had no
// length cap or character restriction at creation (workspace/create just
// checked it was truthy) and flows unescaped-for-*headers* into email
// "From" display names (BRAND_FROM(agencyNameRaw) in lib/email/templates.ts)
// and subject lines across ~10 templates. escapeHtml (above) protects the
// HTML body, correctly, but it doesn't address header-style injection —
// a different character class (CR/LF) that HTML-escaping was never meant
// to catch. Whether Resend's JSON-API "from" field is actually exploitable
// this way is unclear (it's not raw SMTP header composition), but there's
// no reason a display name needs newlines or control characters, so this
// closes the gap defensively regardless of that uncertainty.
// FIX (Workspace lifecycle independent pass — B3 / B11): this only removed ASCII control
// characters, so a display name could still be made of things that render as NOTHING
// (zero-width space U+200B, word joiner, invisible separators, Hangul/Braille filler
// characters U+115F/U+1160/U+3164/U+FFA0/U+2800) or could flip the rendering direction of
// whatever follows it (U+202E "right-to-left override", the isolates U+2066-2069). Because
// users.name / workspaces.agency_name feed the audit log, notifications, team lists and the
// From line of outgoing email, that lets a person be blank or impersonate someone else
// ("Admin" + RLO + "gnirts"). The route-level "is it empty?" checks were also defeated: a
// name of three zero-width spaces is truthy.
//   * All Unicode format characters (\p{Cf}: bidi controls, zero-width space/word-joiner,
//     BOM, soft hyphen, tag characters, ...) are removed — EXCEPT ZWNJ (U+200C) and ZWJ
//     (U+200D), which real names need (Persian/Urdu/Indic shaping, emoji sequences); those are
//     only ever allowed alongside at least one visible character, checked below.
//   * Filler characters that draw as blanks are treated as whitespace.
//   * A name with no visible character at all comes back as '' so callers' existing
//     "required" checks reject it.
//   * B11: slicing at maxLength could cut an emoji's surrogate pair in half; the lone
//     surrogate is not valid in a JSON body to Postgres and made the whole write fail.
export function sanitizeDisplayName(text: string | null | undefined, maxLength = 120): string {
  if (!text) return ''
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\r\n\x00-\x1F\x7F-\x9F]/g, ' ')
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, '')
    // FIX (Workspace lifecycle independent pass 8 — B1): an unpaired surrogate (half an emoji) anywhere in the
    // string, not just at the length cut handled below, is not valid in the JSON body Postgres receives, so the
    // whole write failed (500 from workspace/create and workspace/profile, and every other caller of this helper)
    // instead of the clean 400. Valid surrogate pairs are untouched; a name made only of lone halves comes out
    // empty and the callers' existing "required" checks reject it.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u115F\u1160\u3164\uFFA0\u2800]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Nothing but whitespace / joiners / combining marks left → no visible name.
  // FIX (Workspace lifecycle independent pass 9 — B1): the control-character strip above stopped at
  // \x7F, so the C1 controls (U+0080-U+009F, including U+0085 NEL, which JS \s does not match) survived
  // into stored names and email headers, and a name made of nothing but them counted as present. The
  // visibility test also only excluded whitespace and the joiners, so a name made only of combining or
  // variation characters (U+034F, U+17B4/U+17B5, U+180B-U+180D, U+FE00-U+FE0F, U+E0100..., a lone accent)
  // passed as non-empty yet drew as a blank. Marks (\p{M}) only ever decorate a base character, so a
  // string with no base character at all is not a name; real names always contain one.
  if (!/[^\s\u200C\u200D\p{M}]/u.test(cleaned)) return ''
  return cleaned
    .slice(0, maxLength)
    .replace(/[\uD800-\uDBFF]$/, '')   // don't leave half an emoji at the cut
    .trimEnd()
}
