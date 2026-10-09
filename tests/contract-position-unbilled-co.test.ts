import { describe, it, expect } from 'vitest'
import { unbilledChangeOrderValue } from '@/lib/utils/contract-value'
import { computeContractPositions, toInvoiceContractPosition } from '@/lib/reports/contract-position'

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

const am = (change_order_id: string, financial_impact: number, renewal = false) =>
  ({ change_order_id, financial_impact, change_orders: { is_retainer_renewal: renewal } })

describe('unbilledChangeOrderValue', () => {
  it('counts an approved change order nobody has invoiced', () => {
    expect(unbilledChangeOrderValue([am('c1', 650)], [], 'fixed')).toBe(650)
  })
  it('is zero once a live invoice bills it in full', () => {
    const inv = [{ co_id: 'c1', subtotal: 650, status: 'sent' }]
    expect(unbilledChangeOrderValue([am('c1', 650)], inv, 'fixed')).toBe(0)
  })
  it('counts only the remainder of a part-billed change order, on the net (subtotal) basis', () => {
    const inv = [{ co_id: 'c1', subtotal: 200, amount: 216.5, status: 'paid' }]
    expect(unbilledChangeOrderValue([am('c1', 650)], inv, 'fixed')).toBe(450)
  })
  it('ignores draft and void invoices (they are not live billing)', () => {
    const inv = [{ co_id: 'c1', subtotal: 650, status: 'draft' }, { co_id: 'c1', subtotal: 650, status: 'void' }]
    expect(unbilledChangeOrderValue([am('c1', 650)], inv, 'fixed')).toBe(650)
  })
  it('never goes negative when invoices exceed the change order, and ignores credits', () => {
    expect(unbilledChangeOrderValue([am('c1', 650)], [{ co_id: 'c1', subtotal: 900, status: 'sent' }], 'fixed')).toBe(0)
    expect(unbilledChangeOrderValue([am('c2', -300)], [], 'fixed')).toBe(0)
  })
  it('does not treat a retainer renewal as unbilled work, but does for other change orders on a retainer', () => {
    expect(unbilledChangeOrderValue([am('c1', 6000, true), am('c2', 1000)], [], 'retainer')).toBe(1000)
  })
  it('ignores amendments with no change-order id and invoices raised against something else', () => {
    expect(unbilledChangeOrderValue([{ financial_impact: 500 }], [], 'fixed')).toBe(0)
    expect(unbilledChangeOrderValue([am('c1', 650)], [{ co_id: 'other', subtotal: 650, status: 'sent' }], 'fixed')).toBe(650)
  })
})

describe('contract position carries the unbilled change-order value', () => {
  // The user's own case: 3,000 SOW (50/50, 8.25% tax) + an approved 650 change order, one 1,500 instalment invoiced.
  const tables = {
    amendments: [{ id: 'a1', project_id: 'p1', change_order_id: 'c1', financial_impact: 650, change_orders: { is_retainer_renewal: false } }],
    invoices: [{ id: 'i1', project_id: 'p1', co_id: null, amount: 1623.75, subtotal: 1500, amount_paid: 1623.75, status: 'paid' }],
    change_orders: [],
  }
  it('computes 650 unbilled inside a 3,650 contract with 2,150 left to invoice', async () => {
    const out = await computeContractPositions(fakeService(tables), [{ id: 'p1', contract_value: 3000, type: 'fixed' }])
    const p = out.get('p1')!
    expect(p.contractedValue).toBe(3650)
    expect(p.unbilledChangeOrderValue).toBe(650)
    expect(p.contractedValue - p.invoicedToDate).toBe(2150)
  })
  it('drops to zero once the change order is invoiced', async () => {
    const withCoInvoice = { ...tables, invoices: [...tables.invoices, { id: 'i2', project_id: 'p1', co_id: 'c1', amount: 703.63, subtotal: 650, amount_paid: 0, status: 'sent' }] }
    const out = await computeContractPositions(fakeService(withCoInvoice), [{ id: 'p1', contract_value: 3000, type: 'fixed' }])
    expect(out.get('p1')!.unbilledChangeOrderValue).toBe(0)
  })
  it('shapes the invoice document figure, omitting the line when nothing is unbilled', async () => {
    const out = await computeContractPositions(fakeService(tables), [{ id: 'p1', contract_value: 3000, type: 'fixed' }])
    expect(toInvoiceContractPosition(out.get('p1')!)).toMatchObject({ contractedValue: 3650, invoicedToDate: 1500, excludesTax: true, unbilledChangeOrders: 650 })
    const none = toInvoiceContractPosition({ contractedValue: 3000, invoicedToDate: 1500, paidToDate: 1500, atRiskValue: 0, unbilledChangeOrderValue: 0 })
    expect('unbilledChangeOrders' in none).toBe(false)
  })
})
