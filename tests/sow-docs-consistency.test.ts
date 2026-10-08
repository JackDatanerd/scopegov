// The SOW / change order / invoice set has to read as one consistent document family:
// same legal parties, tax stated wherever money is, one money format, one date style, one contract basis.
import { describe, it, expect } from 'vitest'
import {
  buildBoilerplateSections, buildSowContentPrompt, buildFallbackSections, ensureTaxStated,
  derivedScheduleRows, formatMoneyText, lawWithArticle, splitTax, taxPromptBlock, taxSentenceHtml,
  type SowContentInput,
} from '@/lib/ai/sow-content'
import { coNetImpact } from '@/lib/documents/co-contract-value'
import { dateStyleForCountry, sowDateStyle } from '@/lib/utils/date-style'
import { validateSowForSend } from '@/lib/sow/validate-send'

const base: SowContentInput = {
  agencyName: 'Burnett Specialists', clientName: 'Marla Hensley Realty', projectName: 'Brand', projectType: 'branding',
  contractValue: 4000, currency: 'USD', paymentLabel: '50% upfront, 50% on delivery', paymentStructure: '50_50',
  revisionRounds: 2, governingLaw: 'State of Texas, United States', language: 'en',
  clientRepresentative: 'Faith Christine', clientRepresentativeTitle: 'Branding Lead',
  tax: { rate: 8.25, inclusive: false }, dateStyle: 'us',
}

describe('Parties clause names the contracting company and its signer', () => {
  it('uses Provider/Client and "represented by"', () => {
    const { parties } = buildBoilerplateSections(base)
    expect(parties).toContain('<strong>Burnett Specialists</strong> ("Provider")')
    expect(parties).toContain('<strong>Marla Hensley Realty</strong>, represented by Faith Christine, Branding Lead ("Client")')
    expect(parties).not.toContain('Agency')
  })
  it('is plain when the client contracts personally', () => {
    const { parties } = buildBoilerplateSections({ ...base, clientName: 'Faith Christine', clientRepresentative: null })
    expect(parties).toContain('<strong>Faith Christine</strong> ("Client")')
    expect(parties).not.toContain('represented by')
  })
  it('does not repeat the name when contact and company are the same', () => {
    expect(buildBoilerplateSections({ ...base, clientName: 'Faith Christine', clientRepresentative: 'Faith Christine' }).parties).not.toContain('represented by')
  })
  it('escapes hostile names', () => {
    expect(buildBoilerplateSections({ ...base, clientRepresentative: '<img src=x onerror=1>' }).parties).not.toContain('<img')
  })
})

describe('Governing law grammar', () => {
  it.each([
    ['State of Texas, United States', 'the State of Texas, United States'],
    ['Republic of Kenya', 'the Republic of Kenya'],
    ['the State of Florida', 'the State of Florida'],
    ['Kenya', 'Kenya'],
    ['England and Wales', 'England and Wales'],
  ])('%s', (input, out) => expect(lawWithArticle(input)).toBe(out))
  it('governing_law clause reads correctly and says SOW', () => {
    expect(buildBoilerplateSections(base).governing_law).toBe('<p>This SOW is governed by the laws of the State of Texas, United States.</p>')
  })
})

describe('Tax reaches the drafted Payment Terms', () => {
  it('splits net/tax/gross exactly', () => {
    expect(splitTax(4000, base.tax)).toEqual({ net: 4000, tax: 330, gross: 4330 })
    expect(splitTax(2000, base.tax)).toEqual({ net: 2000, tax: 165, gross: 2165 })
    expect(splitTax(1100, { rate: 10, inclusive: true })).toEqual({ net: 1000, tax: 100, gross: 1100 })
    expect(splitTax(500, null)).toEqual({ net: 500, tax: 0, gross: 500 })
  })
  it('the prompt carries the rate, the totals and each instalment', () => {
    const block = taxPromptBlock(base)
    expect(block).toContain('8.25%')
    expect(block).toContain('USD 4,330.00')
    expect(block).toContain('USD 2,000.00 plus USD 165.00 tax = USD 2,165.00')
    const prompt = buildSowContentPrompt(base)
    expect(prompt).toContain('Contract value (excluding tax): USD 4,000.00')
    expect(prompt).toContain('exactly "USD 4,000.00"')
    expect(prompt).toContain('"Provider"')
  })
  it('no tax setting, no tax text', () => {
    const none = { ...base, tax: null }
    expect(taxPromptBlock(none)).toBe('')
    expect(taxSentenceHtml(none)).toBe('')
    expect(buildSowContentPrompt(none)).not.toContain('Sales tax:')
  })
  it('backstop appends the sentence only when the model omitted the rate', () => {
    const missing = ensureTaxStated('<p>USD 4,000.00 in two parts.</p>', base)
    expect(missing).toContain('8.25%')
    expect(missing).toContain('USD 4,330.00')
    const stated = '<p>Tax at 8.25% applies.</p>'
    expect(ensureTaxStated(stated, base)).toBe(stated)
  })
  it('fallback Payment Terms state tax too', () => {
    expect(buildFallbackSections(base).payment).toContain('8.25%')
  })
  it('does not apply to retainers or non-English documents', () => {
    expect(taxSentenceHtml({ ...base, retainer: { months: 6 } })).toBe('')
    expect(ensureTaxStated('<p>x</p>', { ...base, language: 'es' })).toBe('<p>x</p>')
  })
})

describe('Formats', () => {
  it('money is always code + separators + two decimals', () => {
    expect(formatMoneyText('USD', 4000)).toBe('USD 4,000.00')
    expect(formatMoneyText('USD', 57.75)).toBe('USD 57.75')
  })
  it('date style follows the agency country, in the prompt and the renderer', () => {
    expect(dateStyleForCountry('United States')).toBe('us')
    expect(dateStyleForCountry('USA')).toBe('us')
    expect(dateStyleForCountry('Kenya')).toBe('intl')
    expect(sowDateStyle(null)).toBe('intl')
    expect(buildSowContentPrompt(base)).toContain('"June 16, 2026" (month day, year)')
    expect(buildSowContentPrompt({ ...base, dateStyle: 'intl' })).toContain('"16 June 2026" (day month year)')
  })
  it('prompt keeps timeline, deliverables and overview consistent', () => {
    const p = buildSowContentPrompt(base)
    expect(p).toContain('Use the SAME phase names')
    expect(p).toContain('Do NOT restate the parties preamble')
    expect(p).toContain('hosting, domain registration and going live')
  })
})

describe('Payment Schedule is always populated', () => {
  it('50/50 shows both instalments with tax per row', () => {
    const rows = derivedScheduleRows(base)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ milestone: 'Upfront payment (50%)', amount: '2000', trigger: 'Before work commences · + 8.25% tax (USD 165.00)' })
    expect(rows[1].milestone).toBe('Final payment (50%)')
    expect(rows[1].trigger).toContain('Final delivery approval')
  })
  it('amounts foot to the contract value (odd cents)', () => {
    const rows = derivedScheduleRows({ ...base, contractValue: 1599.97, tax: null })
    expect(rows.map(r => Number(r.amount)).reduce((a, b) => a + b, 0)).toBeCloseTo(1599.97, 2)
  })
  it('single-payment and monthly structures get one row; milestones are authored, not derived', () => {
    expect(derivedScheduleRows({ ...base, paymentStructure: '100_upfront', tax: null })).toHaveLength(1)
    expect(derivedScheduleRows({ ...base, paymentStructure: 'monthly', retainer: { months: null }, tax: null })).toHaveLength(1)
    expect(derivedScheduleRows({ ...base, paymentStructure: 'milestones' })).toEqual([])
  })
  it('is translated for non-English documents', () => {
    expect(derivedScheduleRows({ ...base, language: 'es', tax: null })[0].milestone).toBe('Pago inicial (50%)')
  })
})

describe('Change orders add their NET to the contract value', () => {
  it('uses the subtotal, falls back to total', () => {
    expect(coNetImpact({ subtotal: 700, total: 757.75 })).toBe(700)
    expect(coNetImpact({ subtotal: null, total: 300 })).toBe(300)
    expect(coNetImpact({ subtotal: -500, total: -541.25 })).toBe(-500)
    expect(coNetImpact({})).toBe(0)
  })
})

describe('Send validation flags Payment Terms that omit the tax rate', () => {
  const sections = (payment: string) => [
    { id: 'parties', content: '<p>x</p>', visible: true }, { id: 'payment', content: payment, visible: true },
    { id: 'governing_law', content: '<p>y</p>', visible: true }, { id: 'signature', content: '<p>z</p>', visible: true },
  ]
  it('warns when tax applies but is not mentioned', () => {
    const r = validateSowForSend({ sections: sections('<p>USD 4,000.00 total.</p>'), metadata: { taxRate: 8.25, paymentStructure: '50_50' }, contractValue: 4000 } as any)
    expect(r.warnings.some(w => w.includes('8.25% tax'))).toBe(true)
  })
  it('is quiet when stated', () => {
    const r = validateSowForSend({ sections: sections('<p>USD 4,000.00 total plus 8.25% sales tax.</p>'), metadata: { taxRate: 8.25, paymentStructure: '50_50' }, contractValue: 4000 } as any)
    expect(r.warnings.some(w => w.includes('tax'))).toBe(false)
  })
})
