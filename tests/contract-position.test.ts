import { describe, it, expect } from 'vitest'
import { baseContractValue, computeContractPositions } from '@/lib/reports/contract-position'

// Minimal chainable stand-in for the supabase-js query builder: every filter method returns the builder, and
// awaiting it yields the rows for that table (already "filtered" by the test data).
function fakeService(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      let lo = 0, hi = Infinity
      const b: any = {
        select: () => b, in: () => b, eq: () => b, order: () => b,
        range: (from: number, to: number) => { lo = from; hi = to; return b },
        then: (res: any) => res({ data: (tables[table] || []).slice(lo, hi + 1), error: null }),
      }
      return b
    },
  }
}

describe('baseContractValue', () => {
  it('uses the monthly rate x term for a retainer (contract_value is the MONTHLY rate)', () => {
    expect(baseContractValue({ id: 'p', contract_value: 5000, type: 'retainer', retainer_duration_months: 12 })).toBe(60000)
  })
  it('is the plain contract value otherwise', () => {
    expect(baseContractValue({ id: 'p', contract_value: 5000, type: 'fixed' })).toBe(5000)
    expect(baseContractValue({ id: 'p', contract_value: null })).toBe(0)
    expect(baseContractValue({ id: 'p', contract_value: 5000, type: 'retainer', retainer_duration_months: null })).toBe(5000)
  })
})

describe('computeContractPositions', () => {
  it('computes live invoiced/paid totals including the invoice just sent, excluding draft and void', async () => {
    const svc = fakeService({
      amendments: [{ id: 'a1', project_id: 'p1', financial_impact: 500, change_orders: { is_retainer_renewal: false } }],
      invoices: [
        { id: 'i1', project_id: 'p1', amount: 1100, subtotal: 1000, amount_paid: 1100, status: 'paid' },
        { id: 'i2', project_id: 'p1', amount: 550,  subtotal: 500,  amount_paid: 0,    status: 'sent' },   // "this invoice"
        { id: 'i3', project_id: 'p1', amount: 999,  subtotal: 999,  amount_paid: 0,    status: 'draft' },
        { id: 'i4', project_id: 'p1', amount: 999,  subtotal: 999,  amount_paid: 0,    status: 'void' },
      ],
      change_orders: [{ id: 'c1', project_id: 'p1', total: 300 }],
    })
    const out = await computeContractPositions(svc, [{ id: 'p1', contract_value: 4000, type: 'fixed' }])
    expect(out.get('p1')).toEqual({ contractedValue: 4500, invoicedToDate: 1500, paidToDate: 1100, atRiskValue: 300 })
  })
  it('keeps a voided invoice out of invoiced-to-date but still counts money it actually collected', async () => {
    // FIX (section-12 audit): void/route.ts requires acknowledging any payments
    // already on an invoice before letting it be voided, specifically so that
    // cash isn't forgotten. A voided invoice with $400 already paid on a $999
    // invoice should drop out of "invoiced" (it's not live billing any more)
    // but its $400 must still show up as money collected.
    const svc = fakeService({
      amendments: [],
      invoices: [
        { id: 'i1', project_id: 'p1', amount: 1100, subtotal: 1000, amount_paid: 1100, status: 'paid' },
        { id: 'i2', project_id: 'p1', amount: 999,  subtotal: 999,  amount_paid: 400,  status: 'void' },
        { id: 'i3', project_id: 'p1', amount: 999,  subtotal: 999,  amount_paid: 0,    status: 'draft' },
      ],
      change_orders: [],
    })
    const out = await computeContractPositions(svc, [{ id: 'p1', contract_value: 4000, type: 'fixed' }])
    expect(out.get('p1')).toEqual({ contractedValue: 4000, invoicedToDate: 1000, paidToDate: 1500, atRiskValue: 0 })
  })
  it("does not add a retainer-renewal amendment on top of the rate it replaced", async () => {
    const svc = fakeService({
      amendments: [
        { id: 'a1', project_id: 'r1', financial_impact: 6000, change_orders: { is_retainer_renewal: true } },
        { id: 'a2', project_id: 'r1', financial_impact: 1000, change_orders: { is_retainer_renewal: false } },
      ],
      invoices: [], change_orders: [],
    })
    const out = await computeContractPositions(svc, [{ id: 'r1', contract_value: 6000, type: 'retainer', retainer_duration_months: 12 }])
    expect(out.get('r1')!.contractedValue).toBe(6000 * 12 + 1000)
  })
})
