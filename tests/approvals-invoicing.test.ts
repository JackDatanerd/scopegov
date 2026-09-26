import { describe, it, expect } from 'vitest'
import { pickWorkflow } from '@/lib/approvals/pick-workflow'
import { hasDistinctAssignment } from '@/lib/approvals/eligibility'
import { approvalPermissionOrphanedBy } from '@/lib/utils/admin-floor'
import { computeInvoiceTotals, enteredAmountOf, parseDateOnly } from '@/lib/documents/invoice-totals'
import { isDueDateInPast } from '@/lib/documents/preflight'
import { agingBucket, parseRegistryFilters } from '@/lib/utils/invoice-registry'
import { formatCurrencyExact } from '@/lib/utils/format'

// Section 11 (approval engine) and Section 12 (invoicing) — the pure logic. The database-facing
// pieces (decide_approval_step, finalize_approval_send, finalize_invoice_send, the rounding and
// paid-status triggers in migration 069) need a real Postgres: run them through tests/pg-replay.

describe('pickWorkflow', () => {
  const w = (id: string, threshold: number | null, currency: string | null, other = false) =>
    ({ id, threshold_amount: threshold, threshold_currency: currency, apply_to_other_currencies: other })

  it('the highest threshold the amount clears wins over a lower one and over a catch-all', () => {
    const picked = pickWorkflow([w('a', 1000, 'USD'), w('b', 10000, 'USD'), w('c', null, null)], 12000, 'USD')
    expect(picked?.id).toBe('b')
  })
  it('falls back to the catch-all when no threshold is cleared', () => {
    expect(pickWorkflow([w('a', 1000, 'USD'), w('c', null, null)], 500, 'USD')?.id).toBe('c')
  })
  it('a threshold is never compared against another currency', () => {
    expect(pickWorkflow([w('a', 1000, 'USD')], 5_000_000, 'KES')).toBeNull()
  })
  it('a workflow can opt in to gating every other currency', () => {
    expect(pickWorkflow([w('a', 1000, 'USD', true)], 5, 'KES')?.id).toBe('a')
  })
  it('cross-currency fallback candidates are never ranked by raw magnitude against each other', () => {
    // A 500,000 JPY threshold is not "bigger" than a 5,000 USD one — there is
    // no conversion here, so the raw numbers must not decide seniority across
    // currencies. Only the JPY workflow's own currency-matching numeric
    // comparison is meaningful; picking it just because 500,000 > 5,000 would
    // be the bug.
    const picked = pickWorkflow([w('usd-5k', 5000, 'USD', true), w('jpy-500k', 500000, 'JPY', true)], 100, 'KES')
    // Deterministic (id order among the per-currency finalists), not
    // whichever happened to have the larger raw threshold_amount.
    expect(picked?.id).toBe('jpy-500k') // 'jpy-500k' < 'usd-5k' lexicographically
  })
  it('within the SAME currency, magnitude still decides which fallback workflow wins', () => {
    const picked = pickWorkflow(
      [w('low', 1000, 'USD', true), w('high', 50000, 'USD', true)], 100, 'KES',
    )
    expect(picked?.id).toBe('high')
  })
  it('an amount exactly at the threshold is gated', () => {
    expect(pickWorkflow([w('a', 1000, 'USD')], 1000, 'USD')?.id).toBe('a')
  })
  it('is deterministic when two catch-alls exist (a strict total order)', () => {
    const one = pickWorkflow([w('z', null, null), w('m', null, null)], 1, 'USD')?.id
    const two = pickWorkflow([w('m', null, null), w('z', null, null)], 1, 'USD')?.id
    expect(one).toBe('m')
    expect(two).toBe('m')
  })
  it('returns null when nothing applies', () => {
    expect(pickWorkflow([], 100, 'USD')).toBeNull()
  })
})

describe('hasDistinctAssignment', () => {
  it('is true for an empty chain', () => { expect(hasDistinctAssignment([])).toBe(true) })
  it('is false when one person is the only option for two steps', () => {
    expect(hasDistinctAssignment([['a'], ['a']])).toBe(false)
  })
  it('re-routes an earlier step to make room (augmenting path)', () => {
    expect(hasDistinctAssignment([['a', 'b'], ['a']])).toBe(true)
  })
  it('is false when any step has nobody', () => {
    expect(hasDistinctAssignment([['a'], []])).toBe(false)
  })
})

describe('approvalPermissionOrphanedBy', () => {
  const members = [
    { id: 'm1', effectivePermissions: { APPROVE_DOCUMENTS: true } },
    { id: 'm2', effectivePermissions: { APPROVE_DOCUMENTS: false } },
  ]
  it('is true when the only holder loses it', () => {
    expect(approvalPermissionOrphanedBy(members as any, new Map([['m1', { APPROVE_DOCUMENTS: false }]]))).toBe(true)
  })
  it('is false when another member still holds it', () => {
    const two = [...members, { id: 'm3', effectivePermissions: { APPROVE_DOCUMENTS: true } }]
    expect(approvalPermissionOrphanedBy(two as any, new Map([['m1', { APPROVE_DOCUMENTS: false }]]))).toBe(false)
  })
})

describe('computeInvoiceTotals', () => {
  const ok = (r: any) => { expect(r.ok).toBe(true); return r.totals }

  it('rounds a tax-exclusive gross-up to cents (the amount the PDF prints is the amount stored)', () => {
    const t = ok(computeInvoiceTotals({ entered: 333.33, taxRate: 16, taxInclusive: false }))
    expect(t.amount).toBe(386.66)
    expect(t.subtotal).toBe(333.33)
  })
  it('backs the net out of a tax-inclusive figure', () => {
    const t = ok(computeInvoiceTotals({ entered: 116, taxRate: 16, taxInclusive: true }))
    expect(t.amount).toBe(116)
    expect(t.subtotal).toBe(100)
  })
  it('computes line totals itself and forces itemized invoices to tax-exclusive', () => {
    const t = ok(computeInvoiceTotals({
      entered: 300, taxRate: 10, taxInclusive: true,
      lineItems: [{ description: 'A', quantity: 2, rate: 100, total: 999 }, { description: 'B', quantity: 1, rate: 100 }, { description: '  ' }],
    }))
    expect(t.taxInclusive).toBe(false)
    expect(t.subtotal).toBe(300)
    expect(t.amount).toBe(330)
    expect(t.lineItems).toHaveLength(2)
    expect(t.lineItems[0].total).toBe(200)
  })
  it('rejects a stale amount that disagrees with the line items', () => {
    const r = computeInvoiceTotals({ entered: 999, taxRate: 0, taxInclusive: false, lineItems: [{ description: 'A', quantity: 1, rate: 10 }] })
    expect(r.ok).toBe(false)
  })
  it('rejects bad tax rates, amounts and line items', () => {
    for (const taxRate of [-1, 101, 'abc', NaN, Infinity])
      expect(computeInvoiceTotals({ entered: 10, taxRate, taxInclusive: false }).ok).toBe(false)
    expect(computeInvoiceTotals({ entered: 0, taxRate: 0, taxInclusive: false }).ok).toBe(false)
    expect(computeInvoiceTotals({ entered: Infinity, taxRate: 0, taxInclusive: false }).ok).toBe(false)
    expect(computeInvoiceTotals({ entered: 5, taxRate: 0, taxInclusive: false, lineItems: [{ description: 'A', quantity: -1, rate: 1 }] }).ok).toBe(false)
    expect(computeInvoiceTotals({ entered: 5, taxRate: 0, taxInclusive: false, lineItems: Array.from({ length: 51 }, () => ({ description: 'a', quantity: 1, rate: 1 })) }).ok).toBe(false)
  })
  it('inherits a change order\'s tax terms only when the rate is omitted', () => {
    const t = ok(computeInvoiceTotals({ entered: 100, taxRate: undefined, taxInclusive: undefined, inherited: { taxRate: 8, taxInclusive: false } }))
    expect(t.amount).toBe(108)
  })
  it('never grosses up an already-grossed total when an edit omits the amount', () => {
    const stored = { amount: 386.66, subtotal: 333.33, tax_inclusive: false, tax_rate: 16 }
    const entered = enteredAmountOf(stored)
    expect(entered).toBe(333.33)
    const t = ok(computeInvoiceTotals({ entered, taxRate: 16, taxInclusive: false }))
    expect(t.amount).toBe(386.66)
  })
  it('every tax-exclusive result is a whole number of cents', () => {
    for (let cents = 1000; cents < 300000; cents += 137)
      for (const rate of [5, 7.5, 16, 18]) {
        const t = ok(computeInvoiceTotals({ entered: cents / 100, taxRate: rate, taxInclusive: false }))
        expect(Math.abs(t.amount * 100 - Math.round(t.amount * 100)) < 1e-6).toBe(true)
      }
  })
})

describe('parseDateOnly / isDueDateInPast', () => {
  it('accepts real dates and rejects impossible or non-string ones', () => {
    expect(parseDateOnly('2026-09-21')).toBe('2026-09-21')
    expect(parseDateOnly('2026-09-21T10:00:00Z')).toBe('2026-09-21')
    expect(parseDateOnly('2026-02-30')).toBeNull()
    expect(parseDateOnly('soon')).toBeNull()
    expect(parseDateOnly(5)).toBeNull()
  })
  it('gives a day of slack for time zones before calling a due date past', () => {
    const now = new Date(Date.UTC(2026, 8, 21, 12))
    expect(isDueDateInPast('2026-09-20', now)).toBe(false)
    expect(isDueDateInPast('2026-09-19', now)).toBe(true)
    expect(isDueDateInPast(null, now)).toBe(false)
  })
})

describe('invoice registry helpers', () => {
  const today = new Date(Date.UTC(2026, 8, 21))
  it('buckets unpaid invoices by days past due', () => {
    expect(agingBucket(null, today)).toBe(0)
    expect(agingBucket('2026-09-22', today)).toBe(0)
    expect(agingBucket('2026-09-20', today)).toBe(1)
    expect(agingBucket('2026-08-21', today)).toBe(2)
    expect(agingBucket('2026-07-22', today)).toBe(3)
    expect(agingBucket('2026-06-22', today)).toBe(4)
  })
  it('strips PostgREST filter syntax from a search term and ignores unknown statuses', () => {
    expect(parseRegistryFilters({ status: 'nope', q: 'a,b(c)%*"\\  d ' })).toEqual({ status: '', q: 'a b c d' })
    expect(parseRegistryFilters({ status: 'overdue' }).status).toBe('overdue')
  })
})

describe('formatCurrencyExact', () => {
  it('keeps the cents the whole-unit formatter drops', () => {
    expect(formatCurrencyExact(386.66, 'USD')).toBe('$386.66')
    expect(formatCurrencyExact(0.29, 'USD')).toBe('$0.29')
  })
  it('uses the currency\'s own minor units and handles missing values', () => {
    expect(formatCurrencyExact(1500, 'JPY')).toContain('1,500')
    expect(formatCurrencyExact(null)).toBe('—')
    expect(formatCurrencyExact('abc')).toBe('—')
  })
})
