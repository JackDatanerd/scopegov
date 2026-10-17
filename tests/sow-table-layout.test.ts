import React from 'react'
import { describe, it, expect } from 'vitest'
import { SowTable } from '@/lib/pdf/sow-table'
import { unbilledChangeOrderIds } from '@/lib/utils/contract-value'
import { toInvoiceContractPosition } from '@/lib/reports/contract-position'

const row = (i: number) => ({
  deliverable: `Deliverable ${i} with a reasonably long name that wraps`, acceptanceCriteria: 'Acceptance criteria text that is long enough to wrap onto several lines in its column of the table', owner: 'Provider', targetDate: 'Weekly',
})

describe('SOW table layout: a long table with a lead', () => {
  it('returns the heading group and its continuation as siblings, never inside one wrapping View', () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(i)) as any
    const el: any = (SowTable as any)({ sectionId: 'deliverables', rows, lead: React.createElement('div', null, 'heading') })
    // An outer wrapping View around the unsplittable group made react-pdf squeeze it onto the page it did not fit on.
    expect(el.type).toBe(React.Fragment)
    const kids = React.Children.toArray(el.props.children) as any[]
    expect(kids[0].props.wrap).toBe(false)
    expect(kids.length).toBe(2)
  })
})

describe('contract position names the unbilled change orders', () => {
  const amendments = [
    { change_order_id: 'co1', financial_impact: 700 },
    { change_order_id: 'co2', financial_impact: 300 },
  ] as any
  it('lists only change orders that still have an unbilled amount', () => {
    const invoices = [{ co_id: 'co2', subtotal: 300, amount: 300, status: 'sent' }]
    expect(unbilledChangeOrderIds(amendments, invoices, 'retainer')).toEqual(['co1'])
  })
  it('ignores draft and void invoices when deciding what is billed', () => {
    const invoices = [{ co_id: 'co2', subtotal: 300, status: 'draft' }, { co_id: 'co1', subtotal: 700, status: 'void' }]
    expect(unbilledChangeOrderIds(amendments, invoices, 'fixed')).toEqual(['co1', 'co2'])
  })
  it('carries the document numbers onto the invoice position only when something is unbilled', () => {
    const base = { contractedValue: 1900, invoicedToDate: 1200, paidToDate: 1200, atRiskValue: 0 } as any
    expect(toInvoiceContractPosition({ ...base, unbilledChangeOrderValue: 700, unbilledChangeOrderRefs: ['CO-0011'] }).unbilledChangeOrdersRefs).toEqual(['CO-0011'])
    expect(toInvoiceContractPosition({ ...base, unbilledChangeOrderValue: 0, unbilledChangeOrderRefs: ['CO-0011'] }).unbilledChangeOrdersRefs).toBeUndefined()
  })
})
