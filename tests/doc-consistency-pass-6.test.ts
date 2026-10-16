import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fixedFeePaymentTermsHtml, retainerPaymentTermsHtml, type SowContentInput } from '@/lib/ai/sow-content'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const fixed = (over: Partial<SowContentInput> = {}): SowContentInput => ({
  language: 'en', currency: 'USD', contractValue: 5000, retainer: null, paymentStructure: '50_50', tax: { rate: 8.25, inclusive: true },
  startDate: '2026-11-01', dateStyle: 'us', paymentTermsDays: 14, lateFeeRate: 2.7, ...over,
} as unknown as SowContentInput)
const leads = (html: string) => [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map(m => m[1])

describe('fixed-fee Payment Terms are written by the app', () => {
  it('50/50: fixed labels in a fixed order, every fact from data', () => {
    const html = fixedFeePaymentTermsHtml(fixed(), 'Work pauses on any invoice more than 7 days overdue.')
    expect(leads(html)).toEqual(['Fee.', 'Payment structure.', 'Sales tax.', 'Payment period.', 'Late payment.', 'Suspension of work.'])
    expect(html).toContain('fixed fee of USD 5,000.00, tax included')
    expect(html).toContain('two equal instalments of 50%: the first before work commences on November 1, 2026, and the second on final delivery approval')
    expect(html).toContain('All amounts include sales tax at 8.25%')
    expect(html).toContain('Each invoice is due within 14 days of its invoice date.')
    expect(html).toContain('Work pauses on any invoice more than 7 days overdue.')
  })
  it('upfront and on-delivery structures', () => {
    expect(fixedFeePaymentTermsHtml(fixed({ paymentStructure: '100_upfront' }))).toContain('invoiced in full before work commences on November 1, 2026')
    expect(fixedFeePaymentTermsHtml(fixed({ paymentStructure: 'on_delivery' }))).toContain('invoiced in full on final delivery approval')
  })
  it('exclusive tax, no tax, no start date, no terms: states only what it has', () => {
    const ex = fixedFeePaymentTermsHtml(fixed({ tax: { rate: 8.25, inclusive: false } as any }))
    expect(ex).toContain('plus sales tax')
    expect(ex).toContain('stated exclusive of sales tax')
    const bare = fixedFeePaymentTermsHtml(fixed({ tax: null, startDate: null, paymentTermsDays: null, lateFeeRate: null } as any))
    expect(leads(bare)).toEqual(['Fee.', 'Payment structure.'])
    expect(bare).toContain('before work commences,')
    expect(bare).not.toContain(' on undefined')
  })
  it('is identical on every call', () => {
    expect(fixedFeePaymentTermsHtml(fixed())).toBe(fixedFeePaymentTermsHtml(fixed()))
  })
  it('leaves milestones, retainers and other languages to the existing paths', () => {
    expect(fixedFeePaymentTermsHtml(fixed({ paymentStructure: 'milestones' }))).toBe('')
    expect(fixedFeePaymentTermsHtml(fixed({ retainer: { months: null } as any }))).toBe('')
    expect(fixedFeePaymentTermsHtml(fixed({ language: 'de' }))).toBe('')
    expect(fixedFeePaymentTermsHtml(fixed({ contractValue: 0 }))).toBe('')
  })
  it('the retainer version is unchanged by the shared tail', () => {
    const r = retainerPaymentTermsHtml({ ...fixed({ paymentStructure: 'monthly' }), contractValue: 1200, retainer: { months: null } } as any)
    expect(leads(r)).toEqual(['Monthly retainer fee.', 'Retainer term.', 'Billing.', 'Sales tax.', 'Payment period.', 'Late payment.'])
  })
  it('the generator tries the retainer text, then the fixed-fee text, then keeps the model\u2019s', () => {
    const g = read('app/api/sow/generate/route.ts')
    expect(g).toContain('|| fixedFeePaymentTermsHtml(contentInput, agencyPaymentTermsText(standards))')
    expect(g).toContain('|| allContent.payment')
  })
})
