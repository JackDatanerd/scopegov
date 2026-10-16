import { describe, it, expect } from 'vitest'
import {
  retainerPaymentTermsHtml, fixedFeePaymentTermsHtml, restatesPaymentPeriod, statesLateFeePercent, type SowContentInput,
} from '@/lib/ai/sow-content'
import { lateFeeRateWarning, lateFeeYearlyPercent } from '@/lib/documents/late-fee'
import { validateSowForSend } from '@/lib/sow/validate-send'

const retainer = {
  currency: 'USD', contractValue: 1200, paymentStructure: 'monthly', retainer: { months: null },
  tax: { rate: 8.25, inclusive: false }, paymentTermsDays: 14, lateFeeRate: 2.7, startDate: '2026-11-01',
} as unknown as SowContentInput

const AGENCY = 'Work pauses on any invoice more than 7 days overdue. Invoices are due 14 days of issue.'
const count = (html: string, re: RegExp) => (html.match(re) || []).length

describe('agency standards that restate the payment period', () => {
  it('retainer: the period is stated once, in the well-formed sentence', () => {
    const html = retainerPaymentTermsHtml(retainer, AGENCY)
    expect(count(html, /within 14 days of its invoice date/g)).toBe(1)
    expect(html).not.toMatch(/14 days of issue/)
    expect(html).not.toMatch(/Additional terms/)
  })
  it('retainer: the suspension sentence is kept', () => {
    expect(retainerPaymentTermsHtml(retainer, AGENCY)).toMatch(/<strong>Suspension of work\.<\/strong> Work pauses on any invoice more than 7 days overdue\./)
  })
  it('fixed fee: same behaviour', () => {
    const html = fixedFeePaymentTermsHtml({ ...retainer, retainer: undefined, paymentStructure: '100_upfront' } as unknown as SowContentInput, AGENCY)
    expect(count(html, /due within 14 days|within 14 days of its invoice date/g)).toBe(1)
    expect(html).not.toMatch(/14 days of issue/)
  })
  it('keeps a restatement when the SOW states no period of its own', () => {
    const html = retainerPaymentTermsHtml({ ...retainer, paymentTermsDays: null } as unknown as SowContentInput, AGENCY)
    expect(html).toMatch(/Invoices are due 14 days of issue/)
  })
  it('keeps unrelated agency terms under "Additional terms"', () => {
    const html = retainerPaymentTermsHtml(retainer, 'Invoices are due 14 days of issue. Payment is by bank transfer only.')
    expect(html).toMatch(/<strong>Additional terms\.<\/strong> Payment is by bank transfer only\./)
    expect(html).not.toMatch(/14 days of issue/)
  })
  it('a different late-fee figure from the agency standards never reaches the contract', () => {
    const html = retainerPaymentTermsHtml(retainer, 'A late fee of 1.5% per month applies to overdue invoices.')
    expect(html).toMatch(/late fee of 2\.7% per month/)
    expect(html).not.toMatch(/1\.5%/)
  })
  it('a late-fee sentence is kept when the SOW sets no late fee', () => {
    const html = retainerPaymentTermsHtml({ ...retainer, lateFeeRate: null } as unknown as SowContentInput, 'A late fee of 1.5% per month applies to overdue invoices.')
    expect(html).toMatch(/1\.5%/)
  })
})

describe('restatesPaymentPeriod / statesLateFeePercent', () => {
  it.each([
    ['Invoices are due 14 days of issue.', true],
    ['Payment is due within 14 days of the invoice date.', true],
    ['Net 14.', true],
    ['Invoices are payable in 14 calendar days.', true],
    ['Work pauses on any invoice more than 14 days overdue.', false],
    ['Late payments incur interest after 14 days.', false],
    ['Invoices are due 30 days of issue.', false],
    ['The Client has 14 days to review each deliverable.', false],
  ])('%s -> %s', (s, expected) => expect(restatesPaymentPeriod(s, 14)).toBe(expected))
  it('late fee percent', () => {
    expect(statesLateFeePercent('A late fee of 1.5% per month applies.')).toBe(true)
    expect(statesLateFeePercent('Sales tax of 8.25% is added.')).toBe(false)
    expect(statesLateFeePercent('Overdue amounts carry interest.')).toBe(false)
  })
})

describe('high late fee warning', () => {
  it('2.7% a month is 32.4% a year', () => expect(lateFeeYearlyPercent(2.7)).toBe(32.4))
  it('warns above 1.5% a month, quoting both figures', () => {
    const w = lateFeeRateWarning(2.7)!
    expect(w).toContain('2.7% per month')
    expect(w).toContain('32.4% a year')
  })
  it.each([[1.5], [1], [0], [''], [null], [undefined], ['abc']])('no warning for %s', v => expect(lateFeeRateWarning(v)).toBeNull())
  it('is a send warning, never an error', () => {
    const r = validateSowForSend({
      sections: [{ id: 'payment', content: '<p>Amounts not paid by their due date accrue a late fee of 2.7% per month until paid.</p>' }],
      metadata: { lateFeeRate: 2.7 },
    } as any)
    expect(r.warnings.some(w => w.includes('32.4% a year'))).toBe(true)
    expect(r.errors.some(e => e.includes('32.4%'))).toBe(false)
  })
})
