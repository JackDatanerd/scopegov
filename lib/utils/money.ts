// lib/utils/money.ts
//
// FIX (Notifications & email fix round): emails and in-app notification
// bodies formatted money with `${currency} ${amount.toLocaleString()}`.
// toLocaleString() with no options prints at most 3 fraction digits and
// never pads, so a $1,234.50 invoice went to the client as "USD 1,234.5"
// (and "USD 1,500" for 1500.00, which is fine, but inconsistent with the
// former). It also depended on the server's default locale. This always
// prints the currency's own minor-unit precision in a fixed locale.
//
// The currency label must be a 3-letter code (else USD) — it is interpolated
// into HTML and email subjects by several senders that never escaped it.

function currencyCode(currency: string | null | undefined): string {
  // ISO-4217 codes are exactly three letters; anything else is garbage in (or
  // an attempt to inject markup), so fall back rather than print a fragment.
  const c = String(currency ?? '').trim()
  return /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : 'USD'
}

function fractionDigits(code: string): number {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** "1,234.50" — no currency label. */
export function formatAmount(amount: number | string | null | undefined, currency?: string | null): string {
  const n = Number(amount)
  const safe = Number.isFinite(n) ? n : 0
  const d = fractionDigits(currencyCode(currency))
  return safe.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

/** "USD 1,234.50" */
export function formatMoney(amount: number | string | null | undefined, currency?: string | null): string {
  return `${currencyCode(currency)} ${formatAmount(amount, currency)}`
}
