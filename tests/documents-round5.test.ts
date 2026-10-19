import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { retainerMonthlyGrossFor } from '@/lib/documents/co-contract-value'
import { coImpactNumbers, coAmendmentStatement } from '@/lib/documents/co-impact-view'
import { capDueAtPeriodStart } from '@/lib/documents/advance-due'
import { liabilityCapSentence } from '@/lib/documents/liability-cap'
import { findRecurringStartConflicts } from '@/lib/sow/date-conflicts'
import { toInvoiceContractPosition } from '@/lib/reports/contract-position'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('tax basis stays on the SOW basis (documents round 5)', () => {
  it('the gross monthly retainer is the fee as entered, only when it was entered tax-inclusive', () => {
    expect(retainerMonthlyGrossFor({ contract_value: 1200 }, 1108.55)).toBe(1200)
    expect(retainerMonthlyGrossFor({ contract_value: '1200' }, 1108.55)).toBe(1200)
    expect(retainerMonthlyGrossFor({ contract_value: 1000 }, 1000)).toBeNull()      // tax-exclusive: net equals the entered fee
    expect(retainerMonthlyGrossFor({ contract_value: 1200 }, null)).toBeNull()
    expect(retainerMonthlyGrossFor(null, 1108.55)).toBeNull()
  })
  it('a one-time CO on a tax-inclusive retainer is shown tax included; a tax-exclusive one keeps net rows', () => {
    const base = { taxRate: 8.25, subtotal: 646.65, total: 700, retainerMonthlyNet: 1108.55 }
    expect(coImpactNumbers({ ...base, retainerMonthlyGross: 1200, taxInclusive: true }).inclusiveRetainerView).toBe(true)
    expect(coImpactNumbers({ ...base, retainerMonthlyGross: null, taxInclusive: true }).inclusiveRetainerView).toBe(false)
    expect(coImpactNumbers({ ...base, retainerMonthlyGross: 1200, taxInclusive: false }).inclusiveRetainerView).toBe(false)
    expect(coImpactNumbers({ ...base, retainerMonthlyNet: null, retainerMonthlyGross: 1200, taxInclusive: true }).inclusiveRetainerView).toBe(false)
    expect(coImpactNumbers({ ...base, taxRate: 0, retainerMonthlyGross: 1200, taxInclusive: true }).inclusiveRetainerView).toBe(false)
  })
  it('an open-ended retainer invoice carries a tax-included basis; a fixed contract does not', () => {
    const pos: any = { contractedValue: 1108.55, invoicedToDate: 1108.55, invoicedToDateGross: 1200, paidToDate: 1200, paidToDateNet: 1108.55, hasTax: true, atRiskValue: 0, unbilledChangeOrderValue: 646.65, unbilledChangeOrderGross: 700, openEndedRetainer: true }
    const open = toInvoiceContractPosition(pos)
    expect(open.grossBasis).toEqual({ invoicedToDate: 1200, paidToDate: 1200 })
    expect(open.excludesTax).toBe(true)
    expect(toInvoiceContractPosition({ ...pos, openEndedRetainer: false }).grossBasis).toBeUndefined()
    expect(toInvoiceContractPosition({ ...pos, hasTax: false }).grossBasis).toBeUndefined()
  })
  it('all four render surfaces use the shared rows (PDF, portal page, portal PDF route, executed copy)', () => {
    const r = read('lib/pdf/renderer.tsx')
    expect(r).toContain('inclusiveRetainerView')
    expect(r).toContain('cpGross')
    expect(read('app/portal/co/[token]/page.tsx')).toContain('inclusiveRetainerView')
    expect(read('app/portal/invoice/[token]/page.tsx')).toContain('grossBasis')
    for (const f of ['app/api/pdf/co/[id]/route.ts', 'app/api/portal/co/[token]/pdf/route.ts', 'lib/documents/finalize-co.ts', 'app/api/portal/co/[token]/route.ts'])
      expect(read(f)).toContain('retainerMonthlyGross')
  })
})

describe('change order ties to its SOW (documents round 5)', () => {
  it('names the SOW, and says added work is a deliverable under it (IP and confidentiality)', () => {
    const s = coAmendmentStatement({ sowNumber: 'SOW-0013', total: 700 })
    expect(s.amends).toContain('amends SOW No. SOW-0013')
    expect(s.coverage).toContain('intellectual property and confidentiality')
  })
  it('a credit, a renewal or a CO with no SOW gets no coverage sentence', () => {
    expect(coAmendmentStatement({ sowNumber: 'SOW-1', total: 500, isCredit: true }).coverage).toBeNull()
    expect(coAmendmentStatement({ sowNumber: 'SOW-1', total: 500, isRetainerRenewal: true }).coverage).toBeNull()
    expect(coAmendmentStatement({ sowNumber: null, total: 500 })).toEqual({ amends: null, coverage: null })
  })
  it('the signature block carries the agreement sentence, grouped with the statements above it', () => {
    const r = read('lib/pdf/renderer.tsx')
    expect(r).toContain('By signing below, both parties agree to the terms of this Change Order.')
    expect(r).toContain('travel WITH the signature block')
  })
  it('every document footer reads Page X of Y, one page or many', () => {
    expect(read('lib/pdf/renderer.tsx')).not.toContain('totalPages > 1')
  })
})

describe('advance billing: due before the service month starts', () => {
  it('caps a due date that would fall after the month it pays for has begun', () => {
    expect(capDueAtPeriodStart('2026-11-02', '2026-11-01', '2026-10-19')).toBe('2026-11-01')
  })
  it('never lengthens the period and never touches a month already under way', () => {
    expect(capDueAtPeriodStart('2026-10-25', '2026-11-01', '2026-10-19')).toBe('2026-10-25')
    expect(capDueAtPeriodStart('2026-11-16', '2026-11-01', '2026-11-02')).toBe('2026-11-16')
    expect(capDueAtPeriodStart('2026-11-16', '2026-11-01', '2026-11-01')).toBe('2026-11-16')
  })
  it('does nothing for an invoice that is not a retainer month, or with unreadable dates', () => {
    expect(capDueAtPeriodStart('2026-11-02', null, '2026-10-19')).toBe('2026-11-02')
    expect(capDueAtPeriodStart('', '2026-11-01', '2026-10-19')).toBe('')
    expect(capDueAtPeriodStart('soon', '2026-11-01', '2026-10-19')).toBe('soon')
  })
  it('the invoice form applies it to monthly retainer rows', () => {
    expect(read('components/invoices/BillingTab.tsx')).toContain('capDueAtPeriodStart(chosenDue')
  })
})

describe('liability cap on a retainer', () => {
  it('fixed-fee wording is unchanged', () => {
    expect(liabilityCapSentence('fees_paid')).toContain('will not exceed the fees paid by the Client under this SOW.')
  })
  it('a retainer is capped at the fees of the twelve months before the claim, not everything ever paid', () => {
    const t = liabilityCapSentence('fees_paid', { retainer: true })
    expect(t).toContain('in the twelve months before the event giving rise to the claim')
    expect(t).toContain('cannot be limited by law')
    expect(read('lib/ai/sow-content.ts')).toContain('liabilityCapSentence(cap, { retainer: !!input.retainer })')
  })
})

describe('recurring work has one start date', () => {
  const rows = [{ deliverable: 'Short-form posts', owner: 'Provider', targetDate: 'Weekly from November 13, 2026' }]
  it('flags a Timeline phase that restarts the same cadence on another date', () => {
    const tl = [{ phase: 'Ongoing retainer', description: 'From December 1, 2026 the Provider posts weekly, carries out trend research and issues the monthly analytics report.' }]
    const msgs = findRecurringStartConflicts(rows, tl)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('November 13, 2026')
    expect(msgs[0]).toContain('From December 1, 2026')
  })
  it('accepts the same date, a "continues" sentence, a different cadence and Client rows', () => {
    expect(findRecurringStartConflicts(rows, [{ phase: 'p', description: 'From November 13, 2026 the Provider posts weekly.' }])).toEqual([])
    expect(findRecurringStartConflicts(rows, [{ phase: 'p', description: 'From December 1, 2026 the Provider continues weekly posting.' }])).toEqual([])
    expect(findRecurringStartConflicts(rows, [{ phase: 'p', description: 'From December 1, 2026 the Provider issues the monthly report.' }])).toEqual([])
    expect(findRecurringStartConflicts([{ ...rows[0], owner: 'Client' }], [{ phase: 'p', description: 'From December 1, 2026 weekly footage.' }])).toEqual([])
    expect(findRecurringStartConflicts(null, null)).toEqual([])
  })
  it('runs at drafting (retry) and at send (warning)', () => {
    expect(read('app/api/sow/generate/route.ts')).toContain('findRecurringStartConflicts(aiTables?.deliverables')
    expect(read('lib/sow/validate-send.ts')).toContain('findRecurringStartConflicts(deliverables?.table')
  })
  it('the retainer prompt tells the model to continue, not restart, and to name what arrives each period', () => {
    const s = read('lib/ai/sow-content.ts')
    expect(s).toContain('continues the work, it does not restart it')
    expect(s).toContain('Do not invent a day count, weekday or deadline the brief does not give')
  })
})
