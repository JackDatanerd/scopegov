// lib/documents/co-delivery.ts
//
// One-time work on an open-ended retainer has no baseline delivery date to move, so the change order's Delivery date is the only
// place the client learns when it is due. These helpers keep that date from going missing silently.

import { isOpenEndedRetainer } from '@/lib/documents/co-retainer'

export const MAX_DRAFT_DELIVERY_DAYS = 120

/** ISO date (YYYY-MM-DD) `days` calendar days after `from`; null when `days` is not a usable whole number of days. */
export function deliveryDateFromDays(days: unknown, from: Date = new Date()): string | null {
  const n = typeof days === 'string' && days.trim() ? Number(days) : days
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_DRAFT_DELIVERY_DAYS) return null
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + n))
  return d.toISOString().slice(0, 10)
}

export const DELIVERY_DATE_WARNING = 'This change order adds one-time work to an open-ended retainer but states no delivery date, so it will not tell the client when the work is due. Add a delivery date, or send it as it is.'

/** Warning text when a charged, one-time change order on an open-ended retainer carries no delivery date; otherwise null. */
export function deliveryDateWarning(
  co: { is_retainer_renewal?: boolean | null; is_credit?: boolean | null; total?: number | string | null; revised_delivery_date?: string | null },
  project: { type?: string | null; retainer_duration_months?: number | string | null } | null | undefined,
): string | null {
  if (!isOpenEndedRetainer(project)) return null
  if (co.is_retainer_renewal || co.is_credit) return null
  if (!(Number(co.total) > 0)) return null
  return String(co.revised_delivery_date ?? '').trim() ? null : DELIVERY_DATE_WARNING
}
