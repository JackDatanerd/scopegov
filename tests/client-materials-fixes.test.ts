import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  normalizeClientMaterialsTerms, clientMaterialsSentence, supplyShortfallSentence, applyClientMaterialsTerms, applySupplyShortfall,
  reportsOnExternalData, dataAccessStated, dataAccessPromptLine, reviewWindowCadenceWarning,
} from '@/lib/documents/client-materials'
import { draftingRulesBlock, type SowContentInput } from '@/lib/ai/sow-content'
import { validateSowForSend } from '@/lib/sow/validate-send'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('client-materials terms (opt-in)', () => {
  it('only "standard" turns it on', () => {
    expect(normalizeClientMaterialsTerms('standard')).toBe('standard')
    for (const v of ['', null, undefined, 'yes', true, 1]) expect(normalizeClientMaterialsTerms(v as any)).toBeNull()
  })
  it('off: nothing is added anywhere', () => {
    expect(applyClientMaterialsTerms('<p>IP.</p>', null)).toBe('<p>IP.</p>')
    expect(applySupplyShortfall('<p>A.</p>', null, true)).toBe('<p>A.</p>')
  })
  it('on: the rights paragraph is added to Intellectual Property, once', () => {
    const once = applyClientMaterialsTerms('<p>IP.</p>', 'standard')
    expect(once).toContain('<strong>Client materials.</strong>')
    expect(once).toContain('rights, licences, consents and releases')
    expect(once).toContain('non-exclusive licence to use those materials')
    expect(applyClientMaterialsTerms(once, 'standard')).toBe(once)
  })
  it('on: the shortfall rule is added to a retainer only, once', () => {
    const once = applySupplyShortfall('<p>A.</p>', 'standard', true)
    expect(once).toContain('<strong>Supply of materials.</strong>')
    expect(once).toContain('The monthly fee is unchanged')
    expect(applySupplyShortfall(once, 'standard', true)).toBe(once)
    expect(applySupplyShortfall('<p>A.</p>', 'standard', false)).toBe('<p>A.</p>')
  })
  it('English only', () => {
    expect(applyClientMaterialsTerms('<p>x</p>', 'standard', 'es')).toBe('<p>x</p>')
    expect(applySupplyShortfall('<p>x</p>', 'standard', true, 'de')).toBe('<p>x</p>')
  })
  it('the wording is an indemnity-free, fixed sentence', () => {
    expect(clientMaterialsSentence()).not.toMatch(/indemnif/i)
    expect(supplyShortfallSentence()).toContain('not carried over or credited')
  })
})

describe('reports on data the Provider does not control', () => {
  it.each([
    'A monthly report tracking follower growth and social-to-Shopify traffic referrals, with traffic data',
    'Monthly analytics report with sales data',
    'We will track conversions and report weekly',
  ])('detects: %s', t => expect(reportsOnExternalData(t)).toBe(true))
  it.each(['Weekly posts with captions', 'A monthly report of posts published', 'Trend research'])('ignores: %s', t => expect(reportsOnExternalData(t)).toBe(false))

  it.each([
    'Client gives the Provider view-only access to Shopify analytics by November 1.',
    'The Client will share a weekly export of store traffic data.',
    'Read-only access to Google Analytics is provided by the Client.',
  ])('access stated: %s', t => expect(dataAccessStated(t)).toBe(true))
  it.each([
    'Client grants Provider access to the TikTok and Instagram accounts used for the Solvane presence',
    'Follower growth and social-to-Shopify traffic referrals are tracked and reported monthly. Client supplies footage.',
  ])('access NOT stated: %s', t => expect(dataAccessStated(t)).toBe(false))

  it('the drafting rules ask for it only when the brief promises such a report', () => {
    const base = { language: 'en' } as unknown as SowContentInput
    const withReport = { ...base, deliverables: 'monthly analytics report with traffic data' } as SowContentInput
    expect(draftingRulesBlock(withReport)).toContain('view-only access to where that data lives')
    expect(draftingRulesBlock({ ...base, deliverables: 'weekly posts' } as SowContentInput)).not.toContain('where that data lives')
    expect(dataAccessPromptLine({ deliverables: 'traffic report', language: 'es' })).toBe('')
  })
})

describe('review window against cadence', () => {
  it('warns when the window outlasts a weekly cadence', () => {
    expect(reviewWindowCadenceWarning(7, 'Short-form posts Weekly')).toContain('7 business days')
  })
  it.each([[5, 'Weekly'], [3, 'Weekly'], [7, 'Monthly'], [null, 'Weekly'], [undefined, 'Weekly'], [7.5, 'Weekly']])('no warning for %s / %s', (d, t) => {
    expect(reviewWindowCadenceWarning(d, t as string)).toBeNull()
  })
})

// The three documents this was found on: a retainer that reports Shopify traffic, 6 posts a week, 7 business days to review.
const sections = (opts: { access?: boolean } = {}) => [
  { id: 'deliverables', visible: true, content: '', table: [
    { deliverable: 'Account access to TikTok and Instagram', acceptance: 'Client grants Provider access to the TikTok and Instagram accounts used for the Solvane presence', owner: 'Client', target: 'November 1, 2026' },
    { deliverable: 'Short-form posts (6 per week combined)', acceptance: '6 posts published each week', owner: 'Provider', target: 'Weekly' },
    { deliverable: 'Monthly analytics report with traffic data', acceptance: 'A monthly report tracking follower growth and social-to-Shopify traffic referrals, with traffic data', owner: 'Provider', target: 'Monthly' },
  ] },
  { id: 'roles', visible: true, content: '', table: [{ responsibility: 'Provide TikTok and Instagram account access', provider: '', client: 'Yes', notes: 'Due November 1, 2026' }] },
  { id: 'assumptions', visible: true, content: opts.access ? '<p>The Client gives the Provider view-only access to Shopify analytics by November 1, 2026.</p>' : '<p>Client will provide access to the TikTok and Instagram accounts.</p>' },
  { id: 'oos', visible: true, content: '<p>x</p>' },
  { id: 'payment', visible: true, content: '<p>x</p>' },
]
const send = (secs: any[], approvalDays: number | null) => validateSowForSend({
  sections: secs, contractValue: 1200, metadata: { paymentStructure: 'monthly', ...(approvalDays ? { approvalSilence: { mode: 'deemed_approved', days: approvalDays } } : {}) },
} as any)

describe('send check on the retainer from the three documents', () => {
  it('flags the missing data access', () => {
    expect(send(sections(), null).warnings.some(w => w.includes('access to where that data lives'))).toBe(true)
  })
  it('is satisfied once access is stated', () => {
    expect(send(sections({ access: true }), null).warnings.some(w => w.includes('access to where that data lives'))).toBe(false)
  })
  it('flags 7 business days against weekly posts, not 3', () => {
    expect(send(sections({ access: true }), 7).warnings.some(w => w.includes('7 business days to review'))).toBe(true)
    expect(send(sections({ access: true }), 3).warnings.some(w => w.includes('business days to review'))).toBe(false)
  })
  it('never makes either an error', () => {
    const r = send(sections(), 7)
    expect(r.errors.some(e => /view-only|business days to review/.test(e))).toBe(false)
  })
})

describe('wiring', () => {
  it('migration 163 adds a constrained column', () => {
    const sql = read('supabase/migrations/163_client_materials_terms.sql')
    expect(sql).toContain('default_client_materials_terms text')
    expect(sql).toContain("IN ('standard')")
  })
  it('generation reads, applies and freezes the setting', () => {
    const g = read('app/api/sow/generate/route.ts')
    expect(g).toContain("select('default_client_materials_terms')")
    expect(g).toContain('applyClientMaterialsTerms(allContent.ip')
    expect(g).toContain("applySupplyShortfall(allContent.assumptions || ''")
    expect(g).toContain('...(clientMaterialsTerms ? { clientMaterialsTerms } : {})')
  })
  it('settings API, page and form carry it', () => {
    expect(read('app/api/workspace/settings/route.ts')).toContain("defaultClientMaterialsTerms: 'default_client_materials_terms'")
    expect(read('app/(app)/settings/page.tsx')).toContain('default_client_materials_terms')
    expect(read('components/settings/SettingsClient.tsx')).toMatch(/defaultClientMaterialsTerms:\s+ws\?\.default_client_materials_terms \|\| ''/)
  })
})
