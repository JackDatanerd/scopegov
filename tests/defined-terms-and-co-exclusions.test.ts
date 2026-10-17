import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { servicesIsDefined, lowerUndefinedServices } from '@/lib/documents/defined-terms'
import { activitiesStatedAsRemainingExcluded, unnamedRemainingExclusions, unnamedExclusionWarning } from '@/lib/documents/co-exclusions'
import { draftingRulesBlock, type SowContentInput } from '@/lib/ai/sow-content'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('"the Services" is not a defined term unless the text defines it', () => {
  it.each([
    ['will use it only to perform or receive the Services, and', 'will use it only to perform or receive the services, and'],
    ['The Services include 1 revision round.', 'The services include 1 revision round.'],
    ['expressly excluded from the Services and are not covered', 'expressly excluded from the services and are not covered'],
    ['The Services Company supplies footage.', 'The Services Company supplies footage.'],
    ['Acme Financial Services Ltd', 'Acme Financial Services Ltd'],
    ['the services are provided monthly', 'the services are provided monthly'],
  ])('%s', (i, o) => expect(lowerUndefinedServices(i)).toBe(o))

  it('left alone when the text defines it, in straight or curly quotes', () => {
    expect(servicesIsDefined(['<p>The work described here (the "Services") is monthly.</p>'])).toBe(true)
    expect(servicesIsDefined(['<p>The work described here (the \u201cServices\u201d) is monthly.</p>'])).toBe(true)
    expect(servicesIsDefined(['<p>"Services" means the work in the Deliverables table.</p>'])).toBe(true)
    expect(servicesIsDefined(['<p>The Services include captions.</p>'])).toBe(false)
    expect(servicesIsDefined([null, undefined, ''])).toBe(false)
  })
  it('the generator applies it to sections and table cells, and the drafting rules forbid the capital', () => {
    const g = read('app/api/sow/generate/route.ts')
    expect(g).toContain('servicesIsDefined([...Object.values(allContent)')
    expect(g).toContain('lowerUndefinedServices(allContent[k]')
    expect(g).toContain('lowerUndefinedServices(v)')
    expect(draftingRulesBlock({ language: 'en' } as unknown as SowContentInput)).toContain('Never capitalise "services"')
  })
})

describe('the shared signed-SOW lookup', () => {
  const svc = (row: any) => ({ from: () => ({ select: (cols: string) => ({ eq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { ...row, _cols: cols } }) }) }) }) }) }) })
  const row = { id: 's', document_number: 'SOW-1', version: 1, metadata: {}, sections: [{ id: 'overview', content: 'x' }, { id: 'oos', content: '<p>Out</p>' }] }
  it('returns the Out of Scope text only when asked', async () => {
    const { findSignedSow } = await import('@/lib/documents/signed-sow')
    const asked: any = await findSignedSow(svc(row), 'p', { withOutOfScope: true })
    expect(asked.sow.outOfScopeHtml).toBe('<p>Out</p>')
    const plain: any = await findSignedSow(svc(row), 'p')
    expect('outOfScopeHtml' in plain.sow).toBe(false)
  })
})

describe('a change order may only say an exclusion "remains" if the SOW names it', () => {
  // SOW-0012's Out of Scope item, and CO-0011's Impact Analysis, as signed.
  const oos = '<ul><li><strong>Influencer partnerships:</strong> identifying, negotiating with, contracting, or managing influencers or creators is excluded.</li><li><strong>Paid ad management:</strong> the setup, management, optimization, or reporting of paid advertising on any platform is excluded.</li></ul>'
  const co0011 = 'Identifying influencers falls under the "Influencer partnerships" item of the "Out of Scope" section, which excludes identifying, negotiating with, contracting, or managing influencers or creators; this change order amends that exclusion for the identification of influencers only. Identifying affiliate partners is not named in that exclusion and is added by this change order as additional work. Negotiating with, contracting, managing, and contacting influencers, creators, or affiliate partners remain excluded, and every other exclusion stays in place. The new work is delivered once, and any changes to it would need a further change order.'
  const co0010 = 'Negotiating with, contracting and managing influencers, creators or affiliate partners remain excluded.'

  it('finds the activities in the "remain excluded" sentence only', () => {
    expect(activitiesStatedAsRemainingExcluded(co0011)).toEqual(['negotiating', 'contracting', 'managing', 'contacting'])
  })
  it('CO-0011: "contacting" is not in the SOW, so it is flagged', () => {
    expect(unnamedRemainingExclusions(co0011, oos)).toEqual(['contacting'])
  })
  it('CO-0010 wording is fully covered by the SOW', () => {
    expect(unnamedRemainingExclusions(co0010, oos)).toEqual([])
  })
  it('says nothing when there is no remain-excluded sentence or no SOW text to compare with', () => {
    expect(unnamedRemainingExclusions('This change order does not include contacting creators.', oos)).toEqual([])
    expect(unnamedRemainingExclusions(co0011, '')).toEqual([])
    expect(unnamedRemainingExclusions(null, oos)).toEqual([])
  })
  it('"including" and similar words are not activities', () => {
    expect(activitiesStatedAsRemainingExcluded('Work including hosting remains excluded.')).toEqual(['hosting'])
  })
  it('warning wording, singular and plural, and null for none', () => {
    expect(unnamedExclusionWarning(['contacting'])).toContain('contacting remains excluded')
    expect(unnamedExclusionWarning(['contacting', 'hosting'])).toContain('contacting and hosting remain excluded')
    expect(unnamedExclusionWarning([])).toBeNull()
  })
  it('CO send raises it as an acknowledgeable document warning, and the draft prompt asks for the right wording', () => {
    const r = read('app/api/co/[id]/send/route.ts')
    expect(r).toContain('findSignedSow(service, co.project_id, { withOutOfScope: true })')
    expect(r).toContain('unnamedRemainingExclusions(co.scope_impact_note, sowLookup.sow.outOfScopeHtml)')
    expect(r).not.toContain(".from('sow_documents')")
    expect(read('app/api/co/draft/route.ts')).toContain('"This change order does not include <activity>"')
  })
})
