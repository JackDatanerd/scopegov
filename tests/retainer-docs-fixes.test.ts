import { describe, it, expect } from 'vitest'
import { taxPromptBlock, taxSentenceHtml, derivedScheduleRows, dedupePaymentPeriodSentences, applyAgencyStandards, draftingRulesBlock, type SowContentInput } from '@/lib/ai/sow-content'
import { taxBasisMismatch } from '@/lib/documents/tax-basis-gap'
import { normalizeDraftQuantity } from '@/lib/documents/co-draft-quantity'
import { firstRetainerMonth, retainerMonthKey, retainerMonthLabel } from '@/lib/documents/retainer-period'
import { toInvoiceContractPosition } from '@/lib/reports/contract-position'

const retainer = (inclusive: boolean): SowContentInput => ({
  currency: 'USD', contractValue: 1200, paymentStructure: 'monthly', retainer: { months: null },
  tax: { rate: 8.25, inclusive },
} as unknown as SowContentInput)

describe('retainer SOWs state tax', () => {
  it('exclusive: states per-month tax on top', () => {
    expect(taxPromptBlock(retainer(false))).toMatch(/IN ADDITION to the monthly retainer fee/)
    const s = taxSentenceHtml(retainer(false))
    expect(s).toMatch(/8\.25%/); expect(s).toMatch(/1,299\.00|1299\.00/); expect(s).toMatch(/per month/)
  })
  it('inclusive: states the fee includes tax', () => {
    expect(taxSentenceHtml(retainer(true))).toMatch(/includes sales tax at 8\.25%/)
  })
  it('schedule row carries the tax note', () => {
    const rows = derivedScheduleRows(retainer(false))
    expect(rows[0].trigger).toMatch(/\+ 8\.25%/)
  })
  it('retainer drafting rules ask for cadence', () => {
    expect(draftingRulesBlock(retainer(false))).toMatch(/Weekly/)
  })
})

describe('payment sentence handling', () => {
  it('prefers the well-formed due-days sentence over a malformed model one', () => {
    const html = '<p><strong>Payment period.</strong> Invoices are due 14 days of issue.</p><p>Each invoice is due within 14 days of its invoice date.</p>'
    const out = dedupePaymentPeriodSentences(html, 14)
    expect(out).toMatch(/within 14 days/)
    expect(out).not.toMatch(/14 days of issue/)
  })
  it('does not duplicate a standard the model already worded differently', () => {
    const out = applyAgencyStandards(
      { payment: '<p>Work pauses on any invoice more than 7 days overdue, and resumes once the overdue amount is paid.</p>' },
      { paymentTerms: 'Work pauses on any invoice more than 7 days overdue.' } as any,
    )
    expect((out.payment.match(/Work pauses/g) || []).length).toBe(1)
  })
})

describe('tax basis guard', () => {
  const sow = { taxRate: 8.25, taxInclusive: false } as any
  it('flags an inclusive document against an exclusive SOW', () => {
    expect(taxBasisMismatch('invoice', { taxRate: 8.25, taxInclusive: true }, sow)).toMatch(/added on top/)
  })
  it('flags a different rate and a missing tax', () => {
    expect(taxBasisMismatch('change order', { taxRate: 5, taxInclusive: false }, sow)).toBeTruthy()
    expect(taxBasisMismatch('invoice', { taxRate: 0, taxInclusive: false }, sow)).toMatch(/no tax/)
  })
  it('is silent when they agree or the SOW states no tax', () => {
    expect(taxBasisMismatch('invoice', { taxRate: 8.25, taxInclusive: false }, sow)).toBeNull()
    expect(taxBasisMismatch('invoice', { taxRate: 8.25, taxInclusive: true }, null)).toBeNull()
  })
})

describe('draft quantity', () => {
  it('one named deliverable is quantity 1', () => {
    expect(normalizeDraftQuantity('Research and shortlist of candidates, delivered as a single shortlist document of up to 15 candidates', 5)).toBe(1)
  })
  it('a per-unit line keeps its quantity', () => {
    expect(normalizeDraftQuantity('Initial outreach to up to 5 candidates, one introductory message per candidate', 5)).toBe(5)
  })
})

describe('retainer first service month', () => {
  it('signed in October, starting in November -> November', () => {
    const m = firstRetainerMonth(new Date('2026-10-12T10:00:00Z'), '2026-11-01')
    expect(retainerMonthKey(m)).toBe('2026-11'); expect(retainerMonthLabel(m)).toBe('November 2026')
  })
  it('start in the signing month or earlier, or none -> signing month', () => {
    expect(retainerMonthKey(firstRetainerMonth(new Date('2026-10-12T10:00:00Z'), '2026-10-20'))).toBe('2026-10')
    expect(retainerMonthKey(firstRetainerMonth(new Date('2026-10-12T10:00:00Z'), '2026-09-01'))).toBe('2026-10')
    expect(retainerMonthKey(firstRetainerMonth(new Date('2026-10-12T10:00:00Z'), null))).toBe('2026-10')
  })
})

describe('invoice position on an open-ended retainer', () => {
  it('carries the flag through', () => {
    const p = toInvoiceContractPosition({ contractedValue: 1500, invoicedToDate: 1200, paidToDate: 1200, atRiskValue: 0, openEndedRetainer: true })
    expect(p.openEndedRetainer).toBe(true)
  })
})
