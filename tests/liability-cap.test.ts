import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { normalizeLiabilityCap, liabilityCapSentence } from '@/lib/documents/liability-cap'
import { liabilityCapSectionHtml, buildSowContentPrompt, AI_SECTION_IDS, SOW_SECTION_DEFS, sectionTitle, type SowContentInput } from '@/lib/ai/sow-content'
import { hydrateSections, sanitizeSectionList, defaultSectionVisible } from '@/lib/sow/sections'
import { validateSowForSend } from '@/lib/sow/validate-send'

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
  it('is the content of its own section, not a paragraph of Termination', () => {
    const html = liabilityCapSectionHtml(input)
    expect(html).toContain('neither party is liable')
    expect(html).not.toContain('<strong>')
    expect(SOW_SECTION_DEFS.find(d => d.id === 'liability')?.title).toBe('Limitation of Liability')
    const order = [...SOW_SECTION_DEFS].sort((a, b) => a.order - b.order).map(d => d.id)
    expect(order.indexOf('liability')).toBe(order.indexOf('termination') + 1)
    expect(order[order.length - 1]).toBe('signature')
    expect(new Set(SOW_SECTION_DEFS.map(d => d.order)).size).toBe(SOW_SECTION_DEFS.length)
  })
  it('is never asked of the model or offered for AI regeneration', () => {
    expect(AI_SECTION_IDS).not.toContain('liability')
  })
  it('adds nothing when unset, or for non-English documents', () => {
    expect(liabilityCapSectionHtml({ ...input, liabilityCap: null })).toBe('')
    expect(liabilityCapSectionHtml({ ...input, language: 'fr' })).toBe('')
  })
  it('has a title in every supported language', () => {
    expect(sectionTitle('liability', 'es')).toBe('Limitaci\u00f3n de Responsabilidad')
    expect(sectionTitle('liability', 'de')).toBe('Haftungsbeschr\u00e4nkung')
    expect(sectionTitle('liability', 'sw')).toBe('Ukomo wa Dhima')
    for (const l of ['es', 'fr', 'pt', 'de', 'sw']) expect(sectionTitle('liability', l)).not.toBe('Limitation of Liability')
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
    expect(gen).toContain('allContent.liability = liabilityCapSectionHtml(contentInput)')
    expect(gen).toContain("def.id === 'liability' ? !!allContent.liability : true")
    expect(gen).toContain('...(liabilityCap ? { liabilityCap } : {})')
  })
})

describe('older SOWs and the editor', () => {
  it('an SOW with no liability row gets one, hidden and empty (nothing new appears in a client document)', () => {
    const stored = [{ id: 'termination', title: 'Termination', content: '<p>x</p>', visible: true, order: 13 }]
    const h = hydrateSections(stored, { language: 'en' }).find((x: any) => x.id === 'liability')
    expect(h).toMatchObject({ visible: false, content: '', title: 'Limitation of Liability' })
    const w = sanitizeSectionList([], stored, { language: 'en' }).find((x: any) => x.id === 'liability')
    expect(w.visible).toBe(false)
  })
  it('a stored liability section keeps its own visibility and text', () => {
    const stored = [{ id: 'liability', title: 'x', content: '<p>clause</p>', visible: true, order: 14 }]
    const h = hydrateSections(stored, { language: 'en' }).find((x: any) => x.id === 'liability')
    expect(h).toMatchObject({ visible: true })
    expect(h.content).toContain('clause')
  })
  it('only payment_schedule (milestones) and liability have non-default visibility', () => {
    expect(defaultSectionVisible('liability', {})).toBe(false)
    expect(defaultSectionVisible('payment_schedule', { paymentStructure: 'milestones' })).toBe(true)
    expect(defaultSectionVisible('termination', {})).toBe(true)
  })
  it('send validation refuses a shown but empty liability section, and accepts it hidden or filled', () => {
    const base = [
      { id: 'deliverables', visible: true, content: '', table: [{ deliverable: 'Site' }] },
      { id: 'oos', visible: true, content: '<p>None</p>' },
      { id: 'payment', visible: true, content: '<p>USD 1,000.00</p>' },
    ]
    const run = (liability: any) => validateSowForSend({ sections: [...base, liability], metadata: { paymentStructure: '50_50' }, contractValue: 1000 } as any)
    const empty = run({ id: 'liability', visible: true, content: '' })
    expect(empty.errors.join(' ')).toContain('Limitation of Liability section is shown but empty')
    expect(run({ id: 'liability', visible: false, content: '' }).errors.join(' ')).not.toContain('Limitation of Liability')
    expect(run({ id: 'liability', visible: true, content: '<p>clause</p>' }).errors.join(' ')).not.toContain('Limitation of Liability')
  })
})
