import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { normalizeLiabilityCap, liabilityCapSentence } from '@/lib/documents/liability-cap'
import { ensureLiabilityCapStated, liabilityCapHtml, buildSowContentPrompt, type SowContentInput } from '@/lib/ai/sow-content'

const input = {
  agencyName: 'A', clientName: 'C', projectName: 'P', projectType: 'web', contractValue: 1000, currency: 'USD',
  paymentLabel: '50/50', paymentStructure: '50_50', revisionRounds: 2, governingLaw: 'Kenya', language: 'en', liabilityCap: 'fees_paid',
} as SowContentInput

describe('liability cap', () => {
  it('only the known choice is accepted', () => {
    expect(normalizeLiabilityCap('fees_paid')).toBe('fees_paid')
    for (const v of [null, undefined, '', 'unlimited', 5, {}]) expect(normalizeLiabilityCap(v as any)).toBeNull()
  })
  it('clause is mutual on indirect damages, caps the Provider, and preserves liability the law will not let you limit', () => {
    const t = liabilityCapSentence('fees_paid')
    expect(t).toContain('neither party is liable')
    expect(t).toContain('indirect, incidental, special or consequential')
    expect(t).toContain('fees paid by the Client')
    expect(t).toContain('cannot be limited by law')
  })
  it('is appended to Termination once, never duplicated', () => {
    const once = ensureLiabilityCapStated('<p>Either party may terminate.</p>', input)
    expect(once).toContain('<strong>Limitation of liability.</strong>')
    expect(ensureLiabilityCapStated(once, input)).toBe(once)
  })
  it('adds nothing when unset, or for non-English documents', () => {
    expect(ensureLiabilityCapStated('<p>x</p>', { ...input, liabilityCap: null })).toBe('<p>x</p>')
    expect(liabilityCapHtml({ ...input, language: 'fr' })).toBe('')
  })
  it('the model is told never to write its own', () => {
    expect(buildSowContentPrompt(input)).toContain('Never write a limitation of liability')
  })
})

describe('wiring', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  it('settings, generate and metadata carry it', () => {
    expect(read('app/api/workspace/settings/route.ts')).toContain("defaultLiabilityCap:        'default_liability_cap'")
    expect(read('app/api/workspace/settings/route.ts')).toContain("case 'defaultLiabilityCap'")
    expect(read('app/(app)/settings/page.tsx')).toContain('default_liability_cap')
    expect(read('components/settings/SettingsClient.tsx')).toContain('Limitation of liability')
    const gen = read('app/api/sow/generate/route.ts')
    expect(gen).toContain('ensureLiabilityCapStated(allContent.termination')
    expect(gen).toContain('...(liabilityCap ? { liabilityCap } : {})')
  })
})
