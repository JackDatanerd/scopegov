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

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const MAX_CC_EMAILS = 10

export const CLIENT_LIMITS = {
  name: 200, companyName: 200, email: 254, phone: 50, notes: 5000,
  vatNumber: 50, paymentTermsNote: 1000, addressPart: 200,
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
  if (t.length > max) return { ok: false, error: `${label} is too long (${max} characters max)` }
  return { ok: true, value: t || null }
}

export function normalizeBillingAddress(v: unknown): { ok: true; value: NormalizedBillingAddress | null } | { ok: false; error: string } {
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'Billing address must be an object' }
  const out: NormalizedBillingAddress = {}
  for (const key of ADDRESS_KEYS) {
    const raw = (v as any)[key]
    if (raw === undefined || raw === null || raw === '') continue
    if (typeof raw !== 'string') return { ok: false, error: `Billing address ${key} must be text` }
    const t = raw.trim()
    if (t.length > CLIENT_LIMITS.addressPart) return { ok: false, error: `Billing address ${key} is too long (${CLIENT_LIMITS.addressPart} characters max)` }
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
  ctx: { currentEmail?: string | null } = {},
): ParsedClientInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid request body')
  const updates: Record<string, unknown> = {}

  // name — required, never blank
  if (mode === 'create' || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return fail('Name is required')
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
    const r = normalizeBillingAddress(body.billingAddress)
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
