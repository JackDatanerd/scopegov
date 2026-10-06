// lib/documents/co-input.ts
//
// Validation for the free-form fields of a change order (create + edit share it). These used to go
// straight from the request body to the database: a non-string title crashed on `.trim()`,
// `timelineImpactDays: "abc"` became NaN and a Postgres error whose message was returned to the
// caller, and nothing capped any length.

import { sanitizePlainText, truncateText } from '@/lib/utils/sanitize'
import { parsePlainDecimal } from '@/lib/documents/strict-number'
import { hasVisibleText } from '@/lib/documents/visible-text'

// CO-3: a title made only of invisible characters is not a title (see visible-text.ts).

export const MAX_CO_TITLE_LENGTH      = 200
export const MAX_CO_SCOPE_NOTE_LENGTH = 2000
// The context note is rich text (HTML), so the cap is on the markup, generous enough for a long formatted note.
export const MAX_CO_NOTE_LENGTH       = 20000
export const MAX_CO_TIMELINE_DAYS     = 3650
export const MIN_CO_TIMELINE_DAYS     = -365 // a change order can legitimately pull a date in

export interface ParsedCoFields {
  title?: string
  scopeImpactNote?: string | null
  timelineImpactDays?: number | null
}

export function parseCoFields(body: any): { ok: true; fields: ParsedCoFields } | { ok: false; error: string } {
  const fields: ParsedCoFields = {}

  if (body?.title !== undefined) {
    if (typeof body.title !== 'string') return { ok: false, error: 'title must be text' }
    const title = truncateText(sanitizePlainText(body.title), MAX_CO_TITLE_LENGTH)
    if (!title || !hasVisibleText(title)) return { ok: false, error: 'A change order needs a title' }
    fields.title = title
  }

  if (typeof body?.note === 'string' && body.note.length > MAX_CO_NOTE_LENGTH)
    return { ok: false, error: `The context note is too long (limit ${MAX_CO_NOTE_LENGTH.toLocaleString('en-US')} characters).` }

  if (body?.scopeImpactNote !== undefined) {
    if (body.scopeImpactNote === null) fields.scopeImpactNote = null
    else if (typeof body.scopeImpactNote !== 'string') return { ok: false, error: 'scopeImpactNote must be text' }
    else fields.scopeImpactNote = truncateText(sanitizePlainText(body.scopeImpactNote), MAX_CO_SCOPE_NOTE_LENGTH) || null
  }

  if (body?.timelineImpactDays !== undefined) {
    const raw = body.timelineImpactDays
    if (raw === null || raw === '') fields.timelineImpactDays = null
    else {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? parsePlainDecimal(raw) : NaN
      if (!Number.isInteger(n) || n < MIN_CO_TIMELINE_DAYS || n > MAX_CO_TIMELINE_DAYS)
        return { ok: false, error: `Timeline impact must be a whole number of days between ${MIN_CO_TIMELINE_DAYS} and ${MAX_CO_TIMELINE_DAYS}` }
      fields.timelineImpactDays = n
    }
  }

  return { ok: true, fields }
}
