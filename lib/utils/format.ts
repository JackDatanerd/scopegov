// lib/utils/format.ts
// Re-export ALL_PERMISSIONS so components can import from one place
export { ALL_PERMISSIONS } from '@/lib/supabase/types'

// ── ADDRESS ───────────────────────────────────────────────────────────────────
// FIX (bug — React error #31 "Objects are not valid as a React child"): the
// SOW/CO/Invoice portal pages render `agencyAddress`/`clientBillingAddress`
// as plain text, but workspaces.legal_address and clients.billing_address
// are stored as jsonb objects ({line1, line2, city, region, postalCode,
// country} — see LegalAddress below), not strings. The portal API routes
// were passing that object straight through with no formatting, and the
// page's TS interface incorrectly declared it as `string | null`, so
// nothing caught the mismatch until it crashed in the browser at render
// time. This was previously only solved inline inside lib/pdf/renderer.tsx
// (a PDF-only, server-only module) — extracted here so any route/page that
// needs to display an address, not just the PDF, can share one
// implementation instead of re-deriving it (or, as happened here, silently
// not doing it at all).
export interface LegalAddress {
  line1?:      string | null
  line2?:      string | null
  city?:       string | null
  region?:     string | null
  postalCode?: string | null
  country?:    string | null
}

/** Address as an array of display lines (street, city/region/postal, country) — skips empty parts. */
export function formatAddressLines(a: LegalAddress | null | undefined): string[] {
  if (!a) return []
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(', ')
  return [a.line1, a.line2, cityLine, a.country]
    .filter((l): l is string => !!l && l.trim().length > 0)
}

/** Address as a single string, newline-separated — for contexts (like a portal page's plain div) that render one text node rather than one element per line. */
export function formatAddress(a: LegalAddress | null | undefined): string {
  return formatAddressLines(a).join('\n')
}

// ── CURRENCY ROUNDING ─────────────────────────────────────────────────────────
// FIX (bug — split-brain penny mismatch across SOW/CO/Invoice): contract
// values were being accepted and stored with arbitrary decimal precision
// (e.g. 1599.965 — three digits, which currency should never have) at both
// project-creation and project-edit write paths, with no rounding. That
// single unrounded value then diverged wherever it was independently
// formatted downstream: `.toLocaleString()`-based display rounds the *true*
// underlying binary float (which for 1599.965 is actually a hair under
// .965, so it rounds DOWN to 1599.96), while an LLM asked to describe the
// same value in prose does ordinary textbook rounding on the literal digit
// string it's shown (.965 rounds UP to 1599.97) — same source number,
// two different "correct" roundings, visible as a one-cent mismatch between
// a PDF's header banner and its own body text. Worse, a raw percentage
// split of an unrounded value (contractValue * 0.5) can produce a third
// decimal digit outright (1599.97 * 0.5 = 799.985), which isn't a rounding
// dispute at all — it's just not a valid currency amount. Round to the cent
// at every point money is captured or computed, not just at display time.
export function roundCurrency(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// ── CURRENCY ──────────────────────────────────────────────────────────────────
export function formatCurrency(
  amount: number,
  currency: string = 'USD',
  compact = false
): string {
  if (compact && Math.abs(amount) >= 1000) {
    const val = amount / 1000
    return `${currency} ${val % 1 === 0 ? val : val.toFixed(1)}k`
  }
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toLocaleString()}`
  }
}

// ── DATES ─────────────────────────────────────────────────────────────────────
export function formatDate(date: string | Date | null, opts?: Intl.DateTimeFormatOptions): string {
  if (!date) return '—'
  try {
    return new Intl.DateTimeFormat('en-GB', opts || {
      day: 'numeric', month: 'short', year: 'numeric',
    }).format(new Date(date))
  } catch { return '—' }
}

export function formatRelative(date: string | Date | null): string {
  if (!date) return '—'
  const d = new Date(date)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return formatDate(date)
}

export function timeUntil(date: string | null): string {
  if (!date) return ''
  const diff = new Date(date).getTime() - Date.now()
  const days = Math.ceil(diff / 86400000)
  if (days <= 0) return 'expired'
  if (days === 1) return '1 day left'
  return `${days} days left`
}

// ── STATUS LABELS ─────────────────────────────────────────────────────────────

// BUG-006 carry-forward §6.6: never render raw DB enum values in UI
const PROJECT_STATUS_LABELS: Record<string, string> = {
  'Draft': 'Draft',
  'Intake': 'Intake',
  'Awaiting Signature': 'Awaiting Signature',
  'Changes Requested': 'Changes Requested',
  'Active': 'Active',
  'Stalled': 'Stalled',
  'Complete': 'Complete',
  'Archived': 'Archived',
}
const PROJECT_STATUS_COLOURS: Record<string, string> = {
  'Draft': 'badge-slate',
  'Intake': 'badge-blue',
  'Awaiting Signature': 'badge-amber',
  'Changes Requested': 'badge-amber',
  'Active': 'badge-green',
  'Stalled': 'badge-red',
  'Complete': 'badge-slate',
  'Archived': 'badge-slate',
}
export function projectStatusLabel(status: string) {
  return PROJECT_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}
export function projectStatusColour(status: string) {
  return PROJECT_STATUS_COLOURS[status] ?? 'badge-slate'
}

const SOW_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', awaiting_signature: 'Sent', signed: 'Signed',
  declined: 'Declined', changes_requested: 'Changes Requested',
  withdrawn: 'Withdrawn', expired: 'Expired',
}
const SOW_STATUS_COLOURS: Record<string, string> = {
  draft: 'badge-slate', awaiting_signature: 'badge-amber', signed: 'badge-green',
  declined: 'badge-red', changes_requested: 'badge-amber', withdrawn: 'badge-slate', expired: 'badge-red',
}
export function sowStatusLabel(status: string) {
  return SOW_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}
export function sowStatusColour(status: string) {
  return SOW_STATUS_COLOURS[status] ?? 'badge-slate'
}

const CO_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', awaiting_response: 'Sent', accepted: 'Accepted',
  declined: 'Declined', countered: 'Countered', closed: 'Closed',
  stalled: 'Stalled', withdrawn: 'Withdrawn', exception_granted: 'Exception',
}
const CO_STATUS_COLOURS: Record<string, string> = {
  draft: 'badge-slate', awaiting_response: 'badge-amber', accepted: 'badge-green',
  declined: 'badge-red', countered: 'badge-purple', closed: 'badge-slate',
  stalled: 'badge-red', withdrawn: 'badge-slate', exception_granted: 'badge-blue',
}
export function coStatusLabel(status: string) {
  return CO_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}
export function coStatusColour(status: string) {
  return CO_STATUS_COLOURS[status] ?? 'badge-slate'
}

const FLAG_STATUS_LABELS: Record<string, string> = {
  open: 'Open', resolved: 'Resolved', closed: 'Closed', converted_to_co: 'CO Created',
}
const FLAG_STATUS_COLOURS: Record<string, string> = {
  open: 'badge-red', resolved: 'badge-green', closed: 'badge-slate', converted_to_co: 'badge-blue',
}
export function flagStatusLabel(status: string) {
  return FLAG_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}
export function flagStatusColour(status: string) {
  return FLAG_STATUS_COLOURS[status] ?? 'badge-slate'
}

const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', sent: 'Awaiting payment', partially_paid: 'Partially paid',
  paid: 'Paid', overdue: 'Overdue', void: 'Void',
}
const INVOICE_STATUS_PILL: Record<string, string> = {
  draft: 'slate', sent: 'amber', partially_paid: 'amber', paid: 'green', overdue: 'red', void: 'slate',
}
export function invoiceStatusLabel(status: string) {
  return INVOICE_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}
export function invoicePill(status: string) {
  return INVOICE_STATUS_PILL[status] ?? 'slate'
}

// SOW section keys → human-readable labels
// Carry-forward §2.5: always apply this map before displaying section keys in UI
const SOW_SECTION_LABELS: Record<string, string> = {
  parties: 'Parties', overview: 'Project Overview', deliverables: 'Deliverables',
  oos: 'Out of Scope', assumptions: 'Assumptions & Dependencies',
  timeline: 'Timeline & Milestones', payment: 'Payment Terms',
  revisions: 'Revision Policy', ip: 'Intellectual Property',
  confidentiality: 'Confidentiality', termination: 'Termination',
  governing_law: 'Governing Law', dispute: 'Dispute Resolution', signature: 'Signature',
}
export function sowSectionLabel(key: string): string {
  return SOW_SECTION_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── AI RESPONSE PARSING ───────────────────────────────────────────────────────

// BUG-027 / Carry-forward §1.1: Claude always wraps JSON in fences.
// Apply to EVERY AI response. No exception.
export function stripAndParse<T>(raw: string): T {
  const stripped = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  return JSON.parse(stripped) as T
}

// ── HTML STRIPPING ────────────────────────────────────────────────────────────

// Carry-forward §2.2: strip before Guardian checks AND before word counting
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function countWords(html: string): number {
  return stripHtml(html).split(/\s+/).filter(Boolean).length
}

// ── PROJECT TYPE ──────────────────────────────────────────────────────────────
export const PROJECT_TYPE_LABELS: Record<string, string> = {
  web: 'Web Design', mobile: 'Mobile App', brand: 'Branding',
  ecomm: 'E-Commerce', marketing: 'Marketing', retainer: 'Retainer',
  video: 'Video & Animation', other: 'Other',
}
export const PROJECT_TYPE_ICONS: Record<string, string> = {
  web: 'ti-world-www', mobile: 'ti-device-mobile', brand: 'ti-brush',
  ecomm: 'ti-shopping-cart', marketing: 'ti-speakerphone', retainer: 'ti-refresh',
  video: 'ti-video', other: 'ti-folder',
}

// ── PLAN ──────────────────────────────────────────────────────────────────────
export const PLAN_LABELS: Record<string, string> = {
  trial: 'Trial', solo: 'Solo', starter: 'Starter', pro: 'Pro', agency: 'Agency',
}
export const PLAN_LIMITS: Record<string, { projects: number | null; seats: number; name: string }> = {
  trial:   { projects: null, seats: 10, name: 'Trial (14 days)' },
  solo:    { projects: 2, seats: 1, name: 'Solo' },
  starter: { projects: 5, seats: 2, name: 'Starter' },
  pro:     { projects: null, seats: 4, name: 'Pro' },
  agency:  { projects: null, seats: 10, name: 'Agency' },
}

// ── AVATAR INITIALS ───────────────────────────────────────────────────────────
export function initials(name: string): string {
  return name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)
}

const AVATAR_COLOURS = [
  '#3B82F6','#8B5CF6','#EC4899','#F59E0B','#10B981','#EF4444','#06B6D4','#84CC16',
]
export function avatarColour(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLOURS[Math.abs(hash) % AVATAR_COLOURS.length]
}
