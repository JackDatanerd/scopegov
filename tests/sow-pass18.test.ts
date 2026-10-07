import { describe, it, expect } from 'vitest'
import { validateSowForSend } from '@/lib/sow/validate-send'
import { sanitizeTableRows } from '@/lib/sow/sections'
import { milestoneName } from '@/lib/sow/table-schema'
import { buildFallbackSections } from '@/lib/ai/sow-content'
import { createSowMilestones } from '@/lib/documents/post-signing'

const sections = (table: any[]) => [
  { id: 'parties', content: '<p>x</p>', visible: true },
  { id: 'deliverables', content: '', visible: true, table: [{ deliverable: 'A', acceptanceCriteria: '', owner: 'Provider', targetDate: '' }] },
  { id: 'oos', content: '<p>None</p>', visible: true },
  { id: 'payment', content: '<p>USD 1,000</p>', visible: true },
  { id: 'payment_schedule', content: '', visible: true, table },
  { id: 'governing_law', content: '<p>Kenya</p>', visible: true },
  { id: 'signature', content: '<p>sign</p>', visible: true },
]
const run = (table: any[]) =>
  validateSowForSend({ sections: sections(table) as any, metadata: { paymentStructure: 'milestones' }, contractValue: 1000, projectType: 'fixed' } as any)

describe('SOW pass 18 — B1 invisible milestone names', () => {
  it('milestoneName treats invisible-only as blank and trims real names', () => {
    expect(milestoneName({ milestone: '\u200B\u2060' })).toBe('')
    expect(milestoneName({ milestone: '\u17B4' })).toBe('')
    expect(milestoneName({ milestone: '  Kickoff ' })).toBe('Kickoff')
    expect(milestoneName(null)).toBe('')
  })
  it('send validation no longer counts an invisible-only milestone as a milestone', () => {
    const errs = run([{ milestone: '\u200B', amount: '1000', trigger: 'x' }]).errors.join(' | ')
    expect(errs).toMatch(/at least one milestone/i)
  })
  it('a real schedule still passes', () => {
    expect(run([{ milestone: 'Kickoff', amount: '400', trigger: '' }, { milestone: 'Final', amount: '600', trigger: '' }]).errors).toEqual([])
  })
  it('invisible milestone beside real ones does not add to the footing', () => {
    const r = run([{ milestone: 'Kickoff', amount: '1000', trigger: '' }, { milestone: '\u200B', amount: '50', trigger: '' }])
    expect(r.errors).toEqual([])
  })
  it('sanitizeTableRows stores invisible-only free-text cells empty and keeps real ones', () => {
    const [row] = sanitizeTableRows('payment_schedule', [{ milestone: '\u200B', amount: '1000', trigger: ' Go ' }])
    expect(row.milestone).toBe('')
    expect(row.amount).toBe('1000')
    expect(row.trigger).toBe('Go')
  })
  it('signing does not create a milestone titled with invisible characters', async () => {
    const inserted: any[] = []
    const svc: any = { from: () => ({ insert: (rows: any) => { inserted.push(...[].concat(rows)); return Promise.resolve({ error: null }) } }) }
    await createSowMilestones(svc, 'p', 's', 'w', { paymentStructure: 'milestones' }, 1000, 'USD',
      [{ id: 'payment_schedule', table: [{ milestone: '\u200B', amount: '1000', trigger: '' }] }] as any)
    expect(inserted.every(r => !/^[\s\u200B]*$/.test(r.title))).toBe(true)
  })
})

describe('SOW pass 18 — B2 fallback Out of Scope', () => {
  const base: any = { agencyName: 'A', clientName: 'C', projectName: 'P', projectType: 'x', contractValue: 1000, currency: 'USD',
    paymentLabel: 'x', paymentStructure: '50_50', revisionRounds: 2, governingLaw: 'Kenya' }
  it('a bare dash line produces no empty bullet', () => {
    const oos = buildFallbackSections({ ...base, outOfScope: '-\n- Logo\n*\n\u200B' }).oos
    expect(oos).not.toContain('<li></li>')
    expect(oos).toContain('<li>Logo</li>')
    expect((oos.match(/<li>/g) || []).length).toBe(1)
  })
  it('only dash lines falls back to the "none" wording', () => {
    expect(buildFallbackSections({ ...base, outOfScope: '-\n-' }).oos).not.toContain('<ul>')
  })
})
