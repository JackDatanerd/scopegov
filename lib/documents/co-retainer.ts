// lib/documents/co-retainer.ts
//
// Extra work on a retainer. The app bills a change order ONCE, as its own invoice, and the monthly billing job reads only the
// retainer's monthly rate. Work that continues every month is therefore added by changing that rate: a change order whose lines are
// the current monthly retainer followed by what is new, and whose total becomes the new monthly rate on acceptance (the existing
// "retainer renewal" machinery, which already shows Current Monthly Rate -> New Monthly Rate and works on open-ended retainers).
//
// Pure helpers shared by the editor and the drafting/saving routes.

/** Printed as the first line of a monthly-rate change order, so the client sees the old rate inside the new one. */
export const CURRENT_RATE_LABEL = 'Current monthly retainer (unchanged)'

/** A retainer with no end date. Timeline and delivery-date impact mean nothing for one: there is no delivery date to move. */
export function isOpenEndedRetainer(project: { type?: string | null; retainer_duration_months?: number | string | null } | null | undefined): boolean {
  return !!project && project.type === 'retainer' && !(Number(project.retainer_duration_months) > 0)
}

export interface CoLine { id: string; description: string; quantity: number; rate: number; total: number }

/** Puts the current monthly rate first, once. Nothing changes when the rate is unknown/zero or the line is already there. */
export function withCurrentRateLine<T extends CoLine>(lines: T[], currentRate: number | null | undefined, id: string): T[] {
  const rate = Number(currentRate)
  if (!(rate > 0)) return lines
  if (lines.some(l => l.description === CURRENT_RATE_LABEL)) return lines
  const first = { id, description: CURRENT_RATE_LABEL, quantity: 1, rate, total: rate } as T
  // an untouched empty starter row is replaced rather than left behind
  const kept = lines.filter(l => l.description.trim() !== '' || l.rate > 0)
  return [first, ...kept]
}

export function withoutCurrentRateLine<T extends CoLine>(lines: T[]): T[] {
  const kept = lines.filter(l => l.description !== CURRENT_RATE_LABEL)
  return kept
}

/**
 * The monthly rate a monthly-rate change order sets: the fee AS ENTERED, on the same basis the SOW states it. Tax-inclusive: the
 * total (it contains the tax). Tax added on top: the subtotal, because the monthly invoice adds the tax itself; storing the
 * tax-inclusive total there would tax it twice.
 */
export function monthlyRateFromCo(co: { total?: number | string | null; subtotal?: number | string | null; tax_inclusive?: boolean | null }): number {
  const total = Number(co.total) || 0
  if (co.tax_inclusive) return total
  const sub = co.subtotal == null || co.subtotal === '' ? NaN : Number(co.subtotal)
  return Number.isFinite(sub) ? sub : total
}
