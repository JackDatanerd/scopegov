import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeCoTotals } from '@/lib/documents/co-totals'

// Regression coverage for the section-10 (CO logic) independent pass 3.

function totals(rate: number, tax: number, inclusive: boolean, credit: boolean, qty = 1) {
  const r = computeCoTotals([{ description: 'x', quantity: qty, rate }], tax, inclusive, undefined, { credit })
  if (!r.ok) throw new Error(r.error)
  return r.totals
}

describe('credit CO is the exact mirror of the same charge (half-cent ties)', () => {
  it('10.50 @ 5% tax: charge 11.03 -> credit -11.03 (was -11.02)', () => {
    expect(totals(10.5, 5, false, false).total).toBe(11.03)
    expect(totals(10.5, 5, false, true).total).toBe(-11.03)
  })
  it('credit totals are the negation of charge totals across a wide sweep', () => {
    // Plain comparisons in the hot loop (72k combinations); one expect() each made this take 11s.
    const close = (a: number, b: number) => Math.abs(a - b) < 5e-10 // toBeCloseTo(_, 9)
    const bad: string[] = []
    for (let c = 1; c <= 3000; c++) {
      for (const t of [5, 7.5, 8.25, 16]) for (const inc of [false, true]) for (const qty of [1, 1.33, 3]) {
        const p = totals(c / 100, t, inc, false, qty)
        const n = totals(c / 100, t, inc, true, qty)
        if (!close(n.total, -p.total) || !close(n.subtotal, -p.subtotal) || !close(n.lineItems[0].total, -p.lineItems[0].total)) {
          if (bad.length < 10) bad.push(`rate=${c / 100} tax=${t} inc=${inc} qty=${qty}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
  it('never produces negative zero', () => {
    const t = totals(0, 16, false, true)
    expect(Object.is(t.total, -0)).toBe(false)
    expect(Object.is(t.subtotal, -0)).toBe(false)
  })
  it('non-credit totals are unchanged', () => {
    const t = totals(100, 16, true, false)
    expect(t.total).toBe(100)
    expect(t.subtotal).toBe(86.21)
  })
})

describe('CoEditor honours the server-reported permissions', () => {
  const src = readFileSync('components/co/CoEditor.tsx', 'utf8')
  it('reads canEdit / canSend and locks the form and autosave on them', () => {
    expect(src).toContain('json.permissions?.canEdit')
    expect(src).toContain('json.permissions?.canSend')
    expect(src).toMatch(/isLocked = [^\n]*!canEdit/)
    expect(src).toMatch(/loadFailed \|\| !canEdit/)
  })
  it('refuses to create-then-send for a member without SEND_CHANGE_ORDERS', () => {
    expect(src).toMatch(/async function handleSend\((?:alreadyAcknowledged = false)?\) \{\s*if \(!canSend\)/)
  })
})

describe('GET /api/co/[id] gates the client request text', () => {
  const src = readFileSync('app/api/co/[id]/route.ts', 'utf8')
  it('only members who can act on the flag/CO read flagRequestText', () => {
    expect(src).toContain('canSeeFlagSource')
    expect(src).toMatch(/flagRequestText: string \| null = canSeeFlagSource/)
    expect(src).toContain('canSend: hasPermission(session')
  })
})
