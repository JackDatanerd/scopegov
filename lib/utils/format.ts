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
  // Exact decimal half-up (half away from zero, matching Postgres round()). The old
  // Math.round((n + EPSILON) * 100) mis-rounded ~0.3% of qty × rate products by a cent
  // (0.06 × 34.25 = 2.0549999… → 2.05 instead of 2.06) because EPSILON is meaningless above 1.
  // toPrecision(15) washes float noise, then the decimal shift is done on the string.
  if (!Number.isFinite(n)) return n
  const abs = Math.abs(n)
  if (abs < 1e-6) return 0
  if (abs >= 1e15) return n
  const rounded = Number(Math.round(Number(abs.toPrecision(15) + 'e2')) + 'e-2')
  return rounded === 0 ? 0 : n < 0 ? -rounded : rounded
}

// ── CURRENCY ──────────────────────────────────────────────────────────────────
// FIX (deep audit, section 7): dashboard and projects-list "total contract
// value" metrics used to sum raw contract_value across every project in a
// group regardless of currency, then label the sum with whichever
// project happened to be first in the array — silently adding e.g. USD
// and KES figures together and mislabelling the result. There's no
// exchange-rate conversion anywhere in this codebase (by design — see
// scope-health-rollup/route.ts), so the only honest fix is to never sum
// across currencies: group first, sum within each group, and show every
// currency present instead of picking one.
export function currencyGroupedTotals(
  items: Array<{ contract_value?: number | null; currency?: string | null }>
): Array<{ currency: string; total: number }> {
  const totals = new Map<string, number>()
  for (const item of items) {
    const currency = item.currency || 'USD'
    totals.set(currency, (totals.get(currency) || 0) + (item.contract_value || 0))
  }
  return Array.from(totals.entries())
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => b.total - a.total)
}

export function formatCurrencyGroups(
  items: Array<{ contract_value?: number | null; currency?: string | null }>,
  compact = false,
  // Shown when nothing has a value yet. It used to be hard-coded to USD, so a
  // KES/EUR workspace with no active projects saw "$0" on its dashboard.
  emptyCurrency: string = 'USD'
): string {
  const groups = currencyGroupedTotals(items).filter(g => g.total > 0)
  if (groups.length === 0) return formatCurrency(0, emptyCurrency, compact)
  return groups.map(g => formatCurrency(g.total, g.currency, compact)).join(' · ')
}

export function formatCurrency(
  amount: number,
  currency: string = 'USD',
  compact = false
): string {
  if (compact && Math.abs(amount) >= 1000) {
    // The sign leads the whole string ("-USD 1.5k", matching the "+USD 1.5k" callers build for a positive delta);
    // it used to be formatted inside the number ("USD -1.5k"). Values that round up to 1000k roll over to M
    // ("USD 1.0M", not "USD 1000.0k"), and millions/billions get their own suffix instead of "USD 2500k".
    const sign = amount < 0 ? '-' : ''
    const abs = Math.abs(amount)
    const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
    const round1 = (n: number) => Math.round(n * 10) / 10
    let text: string
    if (round1(abs / 1000) < 1000) text = `${trim(round1(abs / 1000))}k`
    else if (round1(abs / 1e6) < 1000) text = `${trim(round1(abs / 1e6))}M`
    else text = `${trim(round1(abs / 1e9))}B`
    return `${sign}${currency} ${text}`
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

// FIX (section-12 audit, pass 2): formatCurrency() above deliberately rounds to
// whole units — right for contract totals on dashboards, wrong for an invoice
// ledger: an invoice of $386.66 showed as "$387", a $0.29 balance showed as
// "$0 due" on an invoice that was still 'partially_paid', and every recorded
// payment lost its cents. The emails and PDFs print cents (server-side
// formatters), so the app and the document the client received disagreed.
// This keeps the currency's own minor units (2 for USD/EUR/KES, 0 for JPY,
// 3 for KWD…) and is what invoice / payment / approval amounts should use.
export function formatCurrencyExact(
  amount: number | string | null | undefined,
  currency: string = 'USD'
): string {
  if (amount === null || amount === undefined || amount === '') return '—'
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

// ── DATES ─────────────────────────────────────────────────────────────────────
export function formatDate(date: string | Date | null, opts?: Intl.DateTimeFormatOptions): string {
  if (!date) return '—'
  try {
    // FIX (section-7 independent pass, B1): a date-only value ('2026-10-01' — projects.start_date, milestone and
    // invoice due_date, invoice_payments.paid_at) parses as UTC midnight, so formatting it in the viewer's local zone
    // printed the PREVIOUS day west of UTC (and made the client component's text differ from its UTC server render).
    // A calendar date has no zone: format it in UTC. Real timestamps keep the viewer's zone unless the caller sets one.
    const dateOnly = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    const base: Intl.DateTimeFormatOptions = opts || { day: 'numeric', month: 'short', year: 'numeric' }
    return new Intl.DateTimeFormat('en-GB', dateOnly && !base.timeZone ? { ...base, timeZone: 'UTC' } : base)
      .format(new Date(date))
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
  // FIX (section-10 audit, feature gap — CO expiry): 'expired' is a real
  // status now (migration 044 + cron/co-expiry) — without an entry here
  // it fell through to the raw '.replace(/_/g, " ")' fallback, same as
  // SOW's own 'expired' before it got one (see SOW_STATUS_LABELS above).
  expired: 'Expired',
  // FIX (CO-logic fix round): 'awaiting_countersignature' (migration 014)
  // was missing here despite being used everywhere else in the codebase —
  // ProjectDetail.tsx's coStatusLabel() call fell through to the raw
  // fallback for it, rendering the pill as lowercase "awaiting
  // countersignature" next to every sibling status's proper Title Case.
  awaiting_countersignature: 'Awaiting Countersignature',
}
const CO_STATUS_COLOURS: Record<string, string> = {
  draft: 'badge-slate', awaiting_response: 'badge-amber', accepted: 'badge-green',
  declined: 'badge-red', countered: 'badge-purple', closed: 'badge-slate',
  stalled: 'badge-red', withdrawn: 'badge-slate', exception_granted: 'badge-blue',
  expired: 'badge-red',
  // FIX (CO-logic fix round): same gap as the label map above.
  awaiting_countersignature: 'badge-amber',
}
export function coStatusLabel(status: string) {
  return CO_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}
export function coStatusColour(status: string) {
  return CO_STATUS_COLOURS[status] ?? 'badge-slate'
}

const FLAG_STATUS_LABELS: Record<string, string> = {
  open: 'Open', resolved: 'Resolved', closed: 'Closed', converted_to_co: 'CO Created',
  borderline_review: 'Needs review',
}
const FLAG_STATUS_COLOURS: Record<string, string> = {
  open: 'badge-red', resolved: 'badge-green', closed: 'badge-slate', converted_to_co: 'badge-blue',
  borderline_review: 'badge-amber',
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
