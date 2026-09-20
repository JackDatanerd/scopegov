import { describe, it, expect } from 'vitest'
import { computeCoTotals } from '@/lib/documents/co-totals'
import { parseCoFields } from '@/lib/documents/co-input'

describe('computeCoTotals', () => {
  it('derives each line total from the ROUNDED quantity and rate (what the client reads is what is stored)', () => {
    const r = computeCoTotals([{ description: 'Hours', quantity: 1.333, rate: 90 }], 0, false)
    if (!r.ok) throw new Error(r.error)
    const li = r.totals.lineItems[0]
    expect(li.quantity).toBe(1.33)
    expect(li.total).toBe(119.7) // 1.33 × 90, not 119.97
  })
  it('refuses negative quantities and rates', () => {
    expect(computeCoTotals([{ description: 'x', quantity: -1, rate: 10 }], 0, false).ok).toBe(false)
    expect(computeCoTotals([{ description: 'x', quantity: 1, rate: -10 }], 0, false).ok).toBe(false)
  })
  it('lets a system-written adjustment line be negative, so a revision cloned from a countered CO can be saved', () => {
    const r = computeCoTotals([
      { description: 'Build', quantity: 1, rate: 5000 },
      { description: 'Negotiated discount (per counter-offer)', quantity: 7, rate: -1000, kind: 'adjustment' },
    ], 0, false)
    if (!r.ok) throw new Error(r.error)
    expect(r.totals.total).toBe(4000)
    expect(r.totals.lineItems[1].kind).toBe('adjustment')
    expect(r.totals.lineItems[1].quantity).toBe(1) // forced to 1
  })
  it('back-solves the net subtotal for tax-inclusive lines', () => {
    const r = computeCoTotals([{ description: 'Build', quantity: 1, rate: 1160 }], 16, true)
    if (!r.ok) throw new Error(r.error)
    expect(r.totals.total).toBe(1160)
    expect(r.totals.subtotal).toBe(1000)
  })
})

describe('parseCoFields', () => {
  it('accepts a clean body and strips markup', () => {
    const r = parseCoFields({ title: '  <b>Extra pages</b>  ', timelineImpactDays: '5', scopeImpactNote: 'Adds 3 pages' })
    if (!r.ok) throw new Error(r.error)
    expect(r.fields.title).toBe('Extra pages')
    expect(r.fields.timelineImpactDays).toBe(5)
  })
  it('rejects non-string titles and non-numeric / out-of-range days instead of reaching the database', () => {
    expect(parseCoFields({ title: 42 }).ok).toBe(false)
    expect(parseCoFields({ title: '' }).ok).toBe(false)
    expect(parseCoFields({ timelineImpactDays: 'abc' }).ok).toBe(false)
    expect(parseCoFields({ timelineImpactDays: 99999 }).ok).toBe(false)
    expect(parseCoFields({ timelineImpactDays: 2.5 }).ok).toBe(false)
  })
  it('allows a shorter timeline and treats empty as null', () => {
    const a = parseCoFields({ timelineImpactDays: -3 }); if (!a.ok) throw new Error(a.error)
    expect(a.fields.timelineImpactDays).toBe(-3)
    const b = parseCoFields({ timelineImpactDays: '' }); if (!b.ok) throw new Error(b.error)
    expect(b.fields.timelineImpactDays).toBeNull()
  })
  it('caps lengths', () => {
    const r = parseCoFields({ title: 'x'.repeat(500) }); if (!r.ok) throw new Error(r.error)
    expect(r.fields.title!.length).toBe(200)
  })
})
