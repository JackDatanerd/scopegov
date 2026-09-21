// lib/utils/timezone.ts
//
// One place that answers "is this a usable IANA time zone?" and formats
// instants in a workspace's own zone.
//
// Validation deliberately asks the runtime to build a formatter for the zone
// rather than checking membership in Intl.supportedValuesOf('timeZone').
// That list only contains each zone's *canonical* name, so it omits both
// 'UTC' and legitimate current names such as 'Asia/Kolkata' (canonical
// 'Asia/Calcutta' on Node/V8), and it differs between the browser that
// rendered the picker and the server that validates it.

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The zone to render a workspace's dates in: its own if usable, else UTC. */
export function resolveTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? (tz as string) : 'UTC'
}

/**
 * Short zone label for an instant in that zone ("EAT", "GMT+3", "UTC").
 * Falls back to the zone id if the runtime can't produce a short name.
 */
export function timeZoneLabel(tz: string | null | undefined, at: Date = new Date()): string {
  const zone = resolveTimeZone(tz)
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(at)
    return parts.find(p => p.type === 'timeZoneName')?.value || zone
  } catch {
    return zone
  }
}

/** "21 Sep 2026, 14:05 EAT" — an instant rendered in the workspace's zone. */
export function formatDateTimeInZone(
  value: string | number | Date | null | undefined,
  tz: string | null | undefined,
  opts: { seconds?: boolean } = {},
): string {
  if (value === null || value === undefined || value === '') return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const zone = resolveTimeZone(tz)
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', ...(opts.seconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(d)
  return `${text} ${timeZoneLabel(zone, d)}`
}

/** Calendar date (no time) of an instant in the workspace's zone: "21 Sep 2026". */
export function formatDateInZone(
  value: string | number | Date | null | undefined,
  tz: string | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: resolveTimeZone(tz), day: 'numeric', month: 'short', year: 'numeric',
  }).format(d)
}
