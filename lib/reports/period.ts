// lib/reports/period.ts
//
// FIX (Reports & Audit re-pass #3): `period` used to be looked up directly
// in a plain object with the raw query-string value, so
//   - an unknown value ("foo") silently meant "all time" while the PDF still
//     said "Last 90 days" and the filename/audit metadata carried the raw
//     string; and
//   - inherited keys ("constructor", "toString", "__proto__") returned a
//     function, produced NaN, and threw `Invalid time value` -> HTTP 500.
// Parse against an explicit allowlist instead and let the route return 400.

export const PERIOD_KEYS = ['30d', '90d', '6m', '12m', 'all'] as const
export type PeriodKey = (typeof PERIOD_KEYS)[number]

const PERIOD_DAYS: Record<PeriodKey, number | null> = {
  '30d': 30, '90d': 90, '6m': 180, '12m': 365, 'all': null,
}

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  '30d': 'Last 30 days', '90d': 'Last 90 days', '6m': 'Last 6 months', '12m': 'Last 12 months', 'all': 'All time',
}

export function parsePeriod(raw: string | null | undefined, fallback: PeriodKey = '90d'): PeriodKey | null {
  if (raw === null || raw === undefined || raw === '') return fallback
  return (PERIOD_KEYS as readonly string[]).includes(raw) ? (raw as PeriodKey) : null
}

export function periodSince(period: PeriodKey, now: number = Date.now()): string {
  const days = PERIOD_DAYS[period]
  return days ? new Date(now - days * 86400000).toISOString() : '2000-01-01T00:00:00Z'
}
