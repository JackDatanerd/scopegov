// lib/documents/client-dates.ts
//
// Dates the Client owes the Provider (account access, initial materials). The model used to choose them and chose a different deadline
// on every run (Nov 6 / Nov 8 / Nov 4 for the same inputs); a deadline that binds the Client is the agency's decision, so the platform
// computes them from the project start date and a workspace setting and hands them to the model.

/** Adds N business days (Mon-Fri) to an ISO date; N = 0 returns the same date. UTC math, so no timezone drift. */
export function addBusinessDays(iso: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''))
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (Number.isNaN(d.getTime())) return null
  let left = Math.max(0, Math.floor(Number(days) || 0))
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) left--
  }
  return d.toISOString().slice(0, 10)
}

export function normalizeClientMaterialsDays(value: unknown): number | null {
  const n = Number(value)
  return value !== null && value !== '' && value !== undefined && Number.isInteger(n) && n >= 0 && n <= 30 ? n : null
}

export interface ClientDependencyDates { access: string; materials: string }

/** Access is due on the start date; the initial materials N business days later (N unset or 0 = the start date too). */
export function clientDependencyDates(startIso: string | null | undefined, materialsDays: number | null | undefined): ClientDependencyDates | null {
  const start = String(startIso ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null
  const materials = addBusinessDays(start, materialsDays ?? 0)
  return materials ? { access: start, materials } : null
}
