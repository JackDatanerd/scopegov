import { describe, it, expect } from 'vitest'
import {
  normalizePaymentTermsDays, paymentTermsSentenceHtml, paymentTermsPromptBlock, ensurePaymentTermsDaysStated,
  buildSowContentPrompt, type SowContentInput,
} from '@/lib/ai/sow-content'

const base = {
  agencyName: 'Burnett Specialists', clientName: 'Marla Hensley Realty', projectName: 'Site', projectType: 'Web', contractValue: 3000,
  currency: 'USD', paymentLabel: '50/50', paymentStructure: '50_50', revisionRounds: 2, governingLaw: 'State of Texas, United States',
} as SowContentInput

describe('SOW payment period (net days)', () => {
  it('normalises only whole days 1-365', () => {
    expect(normalizePaymentTermsDays(14)).toBe(14)
    expect(normalizePaymentTermsDays('30')).toBe(30)
    for (const bad of [0, -1, 1.5, 366, null, undefined, 'abc']) expect(normalizePaymentTermsDays(bad)).toBeNull()
  })

  it('states the period once, and nothing when no term is set', () => {
    expect(paymentTermsSentenceHtml({ ...base, paymentTermsDays: 14 })).toBe('<p>Each invoice is due within 14 days of its invoice date.</p>')
    expect(paymentTermsSentenceHtml({ ...base, paymentTermsDays: 1 })).toContain('within 1 day of')
    expect(paymentTermsSentenceHtml(base)).toBe('')
    expect(paymentTermsPromptBlock(base)).toBe('')
  })

  it('appends the sentence only when the Payment Terms do not already state the period', () => {
    const input = { ...base, paymentTermsDays: 14 }
    const out = ensurePaymentTermsDaysStated('<p>Two instalments.</p>', input)
    expect(out).toContain('Each invoice is due within 14 days of its invoice date.')
    expect(ensurePaymentTermsDaysStated(out, input)).toBe(out)
    expect(ensurePaymentTermsDaysStated('<p>Payable net 14.</p>', input)).toBe('<p>Payable net 14.</p>')
    expect(ensurePaymentTermsDaysStated('<p>Two instalments.</p>', { ...input, language: 'es' })).toBe('<p>Two instalments.</p>')
  })

  it('puts the timing rule and the CMS-consistency rule in the drafting prompt', () => {
    const prompt = buildSowContentPrompt({ ...base, paymentTermsDays: 14 })
    expect(prompt).toContain('payable within 14 days of its invoice date')
    expect(prompt).toContain('never as "due upfront"')
    expect(prompt).toContain('"beyond" a basic level')
    expect(buildSowContentPrompt(base)).not.toContain('Payment timing:')
  })
})
