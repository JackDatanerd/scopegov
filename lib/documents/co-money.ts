// lib/documents/co-money.ts
//
// How the change-order editor shows money. It used formatCurrency(), which rounds to WHOLE units by design (right for
// dashboard totals), so the editor's "what gets stored and printed" figures were not: 3 x 33.34 (stored and printed as
// 100.02) showed "$100", 386.66 showed "$387", a 0.45 tax line showed "$0", and a 3-decimal currency such as KWD lost its
// last digits - while the PDF and the client's email carry the exact amount. The editor also negates every amount for a
// credit, and -0 formats as "-$0.00" - every blank row and the empty summary of a credit read as a negative zero.
//
// Shows the exact amount in the currency's own minor units (Intl decides: 2 for USD/EUR/KES, 0 for JPY, 3 for KWD), and
// never a negative zero.

import { formatCurrencyExact } from '@/lib/utils/format'

/** `amount` is the positive figure the agency types; `isCredit` shows it as the reduction it is. */
export function formatCoAmount(amount: number, currency: string, isCredit: boolean): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return formatCurrencyExact(0, currency)
  const signed = isCredit ? -n : n
  // `=== 0` is true for -0 as well, so a credit's zero (and a rounding residue of zero) prints as a plain zero.
  return formatCurrencyExact(signed === 0 ? 0 : signed, currency)
}
