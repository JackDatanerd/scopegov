// lib/billing/roi-url.ts
//
// Carries the homepage mini-calculator's numbers into the full calculator (/calculator) through the query string, so a
// visitor who clicks "full calculator" continues with what they typed instead of starting from blank defaults.
// Everything coming back out of a URL is untrusted: it is parsed field by field and clamped by normalizeInputs, and a
// key that is absent or not a number is simply left out (the calculator's own default applies).

import { BLANK_INPUTS, normalizeInputs, type RoiInputs } from '@/lib/billing/roi-model'

type Query = Record<string, string | string[] | undefined> | URLSearchParams

function read(q: Query, key: string): string | undefined {
  if (q instanceof URLSearchParams) return q.get(key) ?? undefined
  const v = q[key]
  return Array.isArray(v) ? v[0] : v
}

/** The calculator fields a URL may prefill. Percentages travel as 0-100 (what the forms show), never as a 0-1 rate. */
export interface CalculatorLinkInputs {
  projectsPerYear: number
  avgProjectValue: number
  creepPct: number
  /** 0-100 */
  recoverPct: number
  seats: number
  activeProjects: number
  interval?: 'monthly' | 'annual'
  needsCustomRoles?: boolean
  needsFullHistory?: boolean
}

export function calculatorHref(i: CalculatorLinkInputs, base = '/calculator'): string {
  const p = new URLSearchParams({
    projects: String(i.projectsPerYear),
    value: String(i.avgProjectValue),
    creep: String(i.creepPct),
    rec: String(i.recoverPct),
    seats: String(i.seats),
    active: String(i.activeProjects),
  })
  if (i.interval) p.set('interval', i.interval)
  if (i.needsCustomRoles) p.set('roles', '1')
  if (i.needsFullHistory) p.set('history', '1')
  return `${base}?${p.toString()}`
}

export function parseCalculatorParams(q: Query): Partial<RoiInputs> {
  const num = (key: string): number | undefined => {
    const raw = read(q, key)
    if (raw === undefined || raw.trim() === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  const raw: Partial<RoiInputs> = {}
  const projects = num('projects'); if (projects !== undefined) raw.projectsPerYear = projects
  const value = num('value');       if (value !== undefined) raw.avgProjectValue = value
  const creep = num('creep');       if (creep !== undefined) raw.creepPct = creep
  const rec = num('rec');           if (rec !== undefined) raw.recoveryRate = rec / 100
  const seats = num('seats');       if (seats !== undefined) raw.seatsNeeded = seats
  const active = num('active');     if (active !== undefined) raw.activeProjectsNeeded = active
  const interval = read(q, 'interval')
  if (interval === 'monthly' || interval === 'annual') raw.interval = interval
  if (read(q, 'roles') === '1') raw.needsCustomRoles = true
  if (read(q, 'history') === '1') raw.needsFullHistory = true

  // Clamp through the model's own normaliser, then keep only the fields the URL actually carried.
  const clamped = normalizeInputs({ ...BLANK_INPUTS, ...raw })
  const out: Partial<RoiInputs> = {}
  for (const k of Object.keys(raw) as Array<keyof RoiInputs>) (out as Record<string, unknown>)[k] = clamped[k]
  return out
}
