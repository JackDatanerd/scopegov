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
