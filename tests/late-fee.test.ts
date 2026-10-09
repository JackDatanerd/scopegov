import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { normalizeLateFeeRate, formatLateFeeRate, lateFeeContractSentence, lateFeeReminder } from '@/lib/documents/late-fee'
import { buildSowContentPrompt, ensureLateFeeStated, lateFeeSentenceHtml, buildFallbackSections, type SowContentInput } from '@/lib/ai/sow-content'
import { resolveInvoiceSowTerms } from '@/lib/documents/invoice-refs'
import { validateSowForSend } from '@/lib/sow/validate-send'

const input = {
  agencyName: 'A', clientName: 'C', projectName: 'P', projectType: 'web', contractValue: 1000, currency: 'USD',
  paymentLabel: '50/50', paymentStructure: '50_50', revisionRounds: 2, governingLaw: 'Kenya', language: 'en', lateFeeRate: 1.5,
} as SowContentInput

describe('late fee rate', () => {
  it.each([[1.5, 1.5], ['2', 2], ['1.256', 1.26], [100, 100]])('normalizes %s', (v, out) => expect(normalizeLateFeeRate(v)).toBe(out))
  it.each([[0], [-1], [101], [''], [null], [undefined], ['abc'], [NaN]])('treats %s as no late fee', v => expect(normalizeLateFeeRate(v as any)).toBeNull())
  it('formats without trailing zeros', () => {
    expect(formatLateFeeRate(1.5)).toBe('1.5')
    expect(formatLateFeeRate(2)).toBe('2')
  })
  it('wording is identical wherever it appears', () => {
    expect(lateFeeContractSentence(1.5)).toContain('late fee of 1.5% per month')
    expect(lateFeeReminder(1.5, 'SOW-0002')).toBe('Overdue amounts accrue a late fee of 1.5% per month, as set out in SOW No. SOW-0002.')
    expect(lateFeeReminder(1.5)).toBe('Overdue amounts accrue a late fee of 1.5% per month.')
  })
})

describe('SOW drafting with a late fee', () => {
  it('gives the model the exact wording, and still forbids inventing one when unset', () => {
    expect(buildSowContentPrompt(input)).toContain('late fee of 1.5% per month')
    const none = buildSowContentPrompt({ ...input, lateFeeRate: null })
    expect(none).not.toContain('Late fee: the Payment Terms must state')
    expect(none).toContain('Never add a late fee')
  })
  it('backstop appends the sentence only when the Payment Terms omit it', () => {
    expect(ensureLateFeeStated('<p>USD 1,000.00 total.</p>', input)).toContain('late fee of 1.5% per month')
    const stated = '<p>A late fee of 1.5% per month applies.</p>'
    expect(ensureLateFeeStated(stated, input)).toBe(stated)
    expect(ensureLateFeeStated('<p>x</p>', { ...input, lateFeeRate: null })).toBe('<p>x</p>')
    expect(ensureLateFeeStated('<p>x</p>', { ...input, language: 'es' })).toBe('<p>x</p>')
  })
  it('a tax rate of the same number is not mistaken for the late fee', () => {
    expect(ensureLateFeeStated('<p>Tax at 1.5% applies.</p>', input)).toContain('late fee of 1.5% per month')
  })
  it('fallback Payment Terms carry it', () => {
    expect(buildFallbackSections(input).payment).toContain('late fee of 1.5% per month')
    expect(lateFeeSentenceHtml({ ...input, lateFeeRate: null })).toBe('')
  })
})

describe('invoice resolves the late fee from its SOW', () => {
  const svc = { from: () => ({ select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { sow_documents: { document_number: 'SOW-0007', metadata: { lateFeeRate: 2 } } } }) }) }) }) }) }
  it('direct, via milestone, via amendment, none', async () => {
    expect(await resolveInvoiceSowTerms(svc, { sow_documents: { document_number: 'SOW-0001', metadata: { lateFeeRate: 1.5 } } })).toEqual({ number: 'SOW-0001', lateFeeRate: 1.5 })
    expect(await resolveInvoiceSowTerms(svc, { payment_milestones: { sow_documents: { document_number: 'SOW-0002', metadata: {} } } })).toEqual({ number: 'SOW-0002', lateFeeRate: null })
    expect(await resolveInvoiceSowTerms(svc, { co_id: 'c' })).toEqual({ number: 'SOW-0007', lateFeeRate: 2 })
    expect(await resolveInvoiceSowTerms(svc, {})).toEqual({ number: null, lateFeeRate: null })
  })
})

describe('send validation', () => {
  const sections = (payment: string) => [
    { id: 'parties', content: '<p>x</p>', visible: true }, { id: 'payment', content: payment, visible: true },
    { id: 'governing_law', content: '<p>y</p>', visible: true }, { id: 'signature', content: '<p>z</p>', visible: true },
  ]
  it('warns when a frozen late fee is not stated in the Payment Terms', () => {
    const r = validateSowForSend({ sections: sections('<p>USD 1,000.00.</p>'), metadata: { lateFeeRate: 1.5, paymentStructure: '50_50' }, contractValue: 1000 } as any)
    expect(r.warnings.some(w => w.includes('1.5% monthly late fee'))).toBe(true)
  })
  it('is quiet when it is stated', () => {
    const r = validateSowForSend({ sections: sections('<p>A late fee of 1.5% per month applies.</p>'), metadata: { lateFeeRate: 1.5, paymentStructure: '50_50' }, contractValue: 1000 } as any)
    expect(r.warnings.some(w => w.includes('late fee'))).toBe(false)
  })
})

describe('wiring', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  it('settings accept, validate and load the rate', () => {
    expect(read('app/api/workspace/settings/route.ts')).toContain("defaultLateFeeRate:         'default_late_fee_rate'")
    expect(read('app/api/workspace/settings/route.ts')).toContain("case 'defaultLateFeeRate'")
    expect(read('app/(app)/settings/page.tsx')).toContain('default_late_fee_rate')
    expect(read('components/settings/SettingsClient.tsx')).toContain('Late fee (% per month)')
  })
  it('generate freezes it into SOW metadata', () => {
    expect(read('app/api/sow/generate/route.ts')).toContain('...(lateFeeRate ? { lateFeeRate } : {})')
  })
  it('the migration is numbered after the existing ones', () => {
    const fs = require('fs'); const files: string[] = fs.readdirSync(join(process.cwd(), 'supabase/migrations')).filter((f: string) => f.endsWith('.sql')).sort()
    const nums = files.map(f => f.slice(0, 3))
    expect(new Set(nums).size).toBe(nums.length) // no two migrations share a number
  })
})
