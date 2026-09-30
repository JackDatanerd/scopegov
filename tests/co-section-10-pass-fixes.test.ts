import { describe, it, expect } from 'vitest'
import { computeCoTotals, stripAdjustmentLines } from '@/lib/documents/co-totals'

// Regression coverage for the section-10 (CO logic) independent pass.

const base = { id: 'a', description: 'Design', quantity: 2, rate: 100, total: 200 }
const discount = { id: 'adj', description: 'Negotiated discount (per counter-offer)', quantity: 1, rate: -30, total: -30, kind: 'adjustment' as const }
const increase = { id: 'adj', description: 'Negotiated increase (per counter-offer)', quantity: 1, rate: 30, total: 30, kind: 'adjustment' as const }

describe('CO-1: switching a negotiated draft to credit', () => {
  it('without shedding, credit mode rejects the negative discount line (the bug)', () => {
    expect(computeCoTotals([base, discount], 0, false, undefined, { credit: true }).ok).toBe(false)
  })
  it('sheds a negative discount line so the credit saves', () => {
    const items = stripAdjustmentLines([base, discount], new Set(['adj']))
    const r = computeCoTotals(items, 0, false, undefined, { credit: true })
    if (!r.ok) throw new Error(r.error)
    expect(r.totals.lineItems).toHaveLength(1)
    expect(r.totals.total).toBe(-200)
  })
  it('sheds a positive increase line instead of turning it into a credit line', () => {
    const items = stripAdjustmentLines([base, increase], new Set(['adj']))
    const r = computeCoTotals(items, 0, false, undefined, { credit: true })
    if (!r.ok) throw new Error(r.error)
    expect(r.totals.total).toBe(-200)
  })
  it('only sheds ids already flagged on this CO; a forged adjustment line is left to validation', () => {
    const forged = { id: 'zzz', description: 'x', quantity: 1, rate: -500, kind: 'adjustment' as const }
    const items = stripAdjustmentLines([base, forged], new Set(['adj']))
    expect(items).toHaveLength(2)
    expect(computeCoTotals(items, 0, false, undefined, { credit: true }).ok).toBe(false)
  })
  it('legacy rows with no kind flag but the fixed wording are shed too', () => {
    const legacy = { id: 'adj', description: 'Negotiated discount (per counter-offer)', quantity: 1, rate: -30, total: -30 }
    expect(stripAdjustmentLines([base, legacy], new Set(['adj']))).toHaveLength(1)
  })
})
