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

/** Strip ALL markup — for fields that must be plain text but are still rendered raw on a portal page (e.g. titles, internal notes). CO `note` and Invoice `paymentInstructions` moved to sanitizeRichText/sanitizeRichTextOrNull — see RichTextField. */
export function sanitizePlainText(text: string | null | undefined): string {
  if (!text) return ''
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }).trim()
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
