import { describe, it, expect } from 'vitest'
import { roundCurrency } from '@/lib/utils/format'
import { computeInvoiceTotals } from '@/lib/documents/invoice-totals'
import { readFileSync } from 'node:fs'

describe('roundCurrency — exact decimal half-up', () => {
  it('rounds half-cent products the way exact decimal arithmetic does', () => {
    expect(roundCurrency(0.06 * 34.25)).toBe(2.06)
    expect(roundCurrency(0.15 * 14.5)).toBe(2.18)
    expect(roundCurrency(2.5 * 19.99)).toBe(49.98)
    expect(roundCurrency(1234567.895)).toBe(1234567.9)
  })
  it('matches exact integer half-up over every qty (0.01–5.00) × rate (0.01–40.00) pair', () => {
    // Plain comparisons in the hot loop (~286k pairs); one expect() per pair made this take 13s.
    const bad: string[] = []
    for (let q = 1; q <= 500; q++) for (let r = 1; r <= 4000; r += 7) {
      const got = Math.round(roundCurrency((q / 100) * (r / 100)) * 100)
      const want = Math.floor((q * r + 50) / 100)
      if (got !== want && bad.length < 10) bad.push(`q=${q} r=${r}: got ${got}, want ${want}`)
    }
    expect(bad).toEqual([])
  })
  it('is symmetric for credits, never returns -0, and passes non-finite through', () => {
    expect(roundCurrency(-2.055)).toBe(-2.06)
    expect(Object.is(roundCurrency(-0.001), 0)).toBe(true)
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3)
    expect(Number.isNaN(roundCurrency(NaN))).toBe(true)
  })
  it('invoice totals use the exact line total', () => {
    const lines = [{ description: 'x', quantity: 0.06, rate: 34.25 }]
    const r = computeInvoiceTotals({ entered: 2.06, taxRate: 0, taxInclusive: false, lineItems: lines })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.totals.amount).toBe(2.06)
  })
})

describe('PDF dates use the workspace timezone', () => {
  const src = readFileSync('lib/pdf/renderer.tsx', 'utf8')
  it('every fmtDate call passes the workspace timezone', () => {
    // fmtDate is only ever called through each document's `fd` wrapper, which is the one place the workspace timezone is passed.
    const raw = src.split('\n').filter(l => l.includes('fmtDate(') && !l.includes('function fmtDate'))
    expect(raw.length).toBe(3) // Sow / Co / Invoice wrappers
    for (const l of raw) expect(l).toContain('data.timeZone')
    expect((src.match(/\bfd\(/g) ?? []).length).toBeGreaterThan(5)
  })
  it.each([
    'app/api/pdf/invoice/[id]/route.ts', 'app/api/pdf/sow/[id]/route.ts', 'app/api/pdf/co/[id]/route.ts',
    'app/api/portal/invoice/[token]/pdf/route.ts', 'app/api/portal/sow/[token]/pdf/route.ts',
    'app/api/portal/sow/[token]/sign/route.ts', 'app/api/portal/co/[token]/pdf/route.ts',
  ])('%s selects and passes workspaces.timezone', (f) => {
    const s = readFileSync(f, 'utf8')
    expect(s).toMatch(/workspaces\(timezone,/)
    expect(s).toMatch(/timeZone:\s*\w+\?\.timezone/)
  })
})
