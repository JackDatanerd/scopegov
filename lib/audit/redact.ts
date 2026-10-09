// lib/audit/redact.ts
//
// Redacts dollar figures out of audit_log.metadata for viewers without
// VIEW_FINANCIALS. Used by the JSON view (event detail), the CSV export.
//
// FIX (Reports & Audit re-pass #3): this used to be a top-level key
// DENYLIST that had to be extended by hand every time someone logged a new
// money-shaped key (it was extended five times in earlier rounds). Any new
// key leaked by default, and nested objects were never inspected. It now
// fails closed:
//   - a key is redacted if the explicit legacy list contains it, OR any of
//     its words (split on _, -, spaces and camelCase) is money-shaped
//     (amount, total, balance, value, price, cost, fee, budget, revenue...);
//   - nested objects/arrays are walked, so { contractValue: { from, to } }
//     and { lines: [{ amount }] } are covered.
// Over-redaction (e.g. a hypothetical `total_flags`) is the deliberate
// trade: the reader can still see the event, actor and every non-money key.

const LEGACY_KEYS = new Set([
  'amount', 'balance_due', 'estimated_value', 'counter_amount', 'client_counter_amount',
  'total', 'subtotal', 'contract_value', 'contractValue', 'schedule_sum',
  'threshold_amount', 'new_monthly_amount',
  // Settings independent pass 12: the Guardian risk-alert threshold is a contract-value figure in the workspace
  // currency; "threshold" is not a money word, so its from/to showed to viewers without VIEW_FINANCIALS.
  'proactiveRiskThreshold', 'proactive_risk_threshold',
])

// FIX (Reports & Audit re-pass #4): the generic "value" word match caught
// scope_adjustment_made's old_value/new_value, which across this codebase
// (scope_adjustments table, scope-financial-data.ts, activity-format.ts)
// are always the deliverable's TITLE text, never a dollar figure — the
// adjustment's actual estimated_value is a separate, correctly-redacted
// field. Redacting them blanked out the one thing a VIEW_AUDIT_LOG-without-
// VIEW_FINANCIALS viewer needed to see: what the change actually was. A
// small explicit exemption, mirroring LEGACY_KEYS in shape, is safer here
// than loosening the generic "value" word match itself, which still needs
// to catch real money-shaped keys like contract_value or schedule_sum.
const NON_MONEY_KEYS = new Set([
  'old_value', 'new_value',
  // A number of days, not an amount (the "payment" word otherwise blanked it).
  'defaultPaymentTermsDays', 'default_payment_terms_days',
  // A percentage rate, not an amount.
  'defaultLateFeeRate', 'default_late_fee_rate',
  'defaultLiabilityCap', 'default_liability_cap',
])

const MONEY_WORDS = new Set([
  'amount', 'amounts', 'balance', 'total', 'subtotal', 'value', 'values',
  'price', 'cost', 'costs', 'fee', 'fees', 'budget', 'revenue', 'sum', 'payment', 'payments',
])

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
}

export function isMoneyKey(key: string): boolean {
  if (LEGACY_KEYS.has(key)) return true
  if (NON_MONEY_KEYS.has(key)) return false
  return words(key).some(w => MONEY_WORDS.has(w))
}

export const REDACTED = '[redacted]'

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>)
  return value
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    out[key] = isMoneyKey(key) ? REDACTED : redactValue(value)
  }
  return out
}

export function redactMetadata(
  metadata: Record<string, unknown> | null | undefined,
  canViewFinancials: boolean,
): Record<string, unknown> | null {
  if (!metadata || !Object.keys(metadata).length) return null
  return canViewFinancials ? metadata : redactObject(metadata)
}

// ── Client data (VIEW_CLIENT_DATA) ───────────────────────────────────────────────────────────────
// VIEW_AUDIT_LOG, VIEW_FINANCIALS and VIEW_CLIENT_DATA are independent toggles on a custom role. The
// clients routes write real contact data into the log (client.updated before/after values for email, phone,
// CC list, VAT number, billing address and payment terms; client.deleted / client.merged carry the client's
// email; client_contact.* carry a contact's name, email and job title), and the reminder events carry
// `client_email`. Without this, a role that can read the audit log but not client data could read every one
// of those values back out of the log — the exact gate the Clients pages enforce everywhere else.
//
// Two rules, both fail-closed:
//   1. client.* / client_contact.* events keep only an allowlist of structural keys; every other key is
//      replaced with REDACTED (so the reader still sees that something was recorded, never what).
//      client_contact.* rows also lose their entity name, which is "<contact name> (<client name>)".
//   2. Every other event: any key that names a client's contact detail (email, client_email, guardian_email,
//      phone, cc_emails, ...) is redacted at any depth.

const CLIENT_EVENT_PREFIXES = ['client.', 'client_contact.']

const CLIENT_EVENT_SAFE_KEYS = new Set([
  'fields', 'client_id', 'role_type', 'is_primary', 'was_primary', 'company_name',
  'projects_moved', 'contacts_moved', 'contacts_dropped', 'cc_dropped', 'notes_truncated', 'target_reactivated',
  'merged_from',
])

const CLIENT_DATA_KEYS = new Set([
  'email', 'clientemail', 'guardianemail', 'phone', 'ccemails', 'cc', 'paymenttermsnote',
  'vatnumber', 'billingaddress', 'contactemail',
])

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/g, '').toLowerCase()
}

export function isClientDataKey(key: string): boolean {
  return CLIENT_DATA_KEYS.has(normalizeKey(key))
}

function redactClientKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(v => redactClientKeys(v))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isClientDataKey(key)) { out[key] = REDACTED; continue }
      out[key] = redactClientKeys(v)
    }
    return out
  }
  return value
}

export function isClientEvent(eventType: string | null | undefined): boolean {
  const t = String(eventType || '')
  return CLIENT_EVENT_PREFIXES.some(p => t.startsWith(p))
}

/**
 * Applies the VIEW_CLIENT_DATA rules to one audit_log row (snake_case, as read from the table).
 * Returns the row untouched for viewers who hold the permission.
 */
export function redactClientDataRow<T extends { event_type?: string | null; entity_name?: string | null; metadata?: any }>(
  row: T, canViewClientData: boolean,
): T {
  if (canViewClientData) return row
  const eventType = String(row.event_type || '')
  const md = row.metadata
  let metadata = md
  if (md && typeof md === 'object' && !Array.isArray(md)) {
    if (isClientEvent(eventType)) {
      const out: Record<string, unknown> = {}
      for (const [key, v] of Object.entries(md as Record<string, unknown>)) {
        out[key] = CLIENT_EVENT_SAFE_KEYS.has(key) ? redactClientKeys(v) : REDACTED
      }
      metadata = out
    } else {
      metadata = redactClientKeys(md)
    }
  }
  const entityName = eventType.startsWith('client_contact.') ? (row.entity_name ? REDACTED : row.entity_name) : row.entity_name
  return { ...row, metadata, entity_name: entityName }
}
