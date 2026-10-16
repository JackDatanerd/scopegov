import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { deliveryBeforeStartWarning } from '@/lib/documents/co-delivery'
import { revisionsUnstatedWarning, REVISIONS_UNSTATED_WARNING } from '@/lib/documents/co-definition'
import { draftingRulesBlock, type SowContentInput } from '@/lib/ai/sow-content'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('change order delivered before the project starts', () => {
  const co = { total: 700, revised_delivery_date: '2026-10-26' }
  it('warns, naming both dates (the retainer from the three documents)', () => {
    const w = deliveryBeforeStartWarning(co, { start_date: '2026-11-01' })!
    expect(w).toContain('October 26, 2026')
    expect(w).toContain('November 1, 2026')
  })
  it('accepts timestamps as well as plain dates', () => {
    expect(deliveryBeforeStartWarning({ total: 1, revised_delivery_date: '2026-10-26T00:00:00Z' }, { start_date: '2026-11-01T00:00:00+00:00' })).toContain('before the project starts')
  })
  it.each([
    ['same day', { total: 700, revised_delivery_date: '2026-11-01' }, { start_date: '2026-11-01' }],
    ['after start', { total: 700, revised_delivery_date: '2026-11-10' }, { start_date: '2026-11-01' }],
    ['no delivery date', { total: 700, revised_delivery_date: null }, { start_date: '2026-11-01' }],
    ['no start date', { total: 700, revised_delivery_date: '2026-10-26' }, { start_date: null }],
    ['no project', { total: 700, revised_delivery_date: '2026-10-26' }, null],
    ['credit', { total: -700, is_credit: true, revised_delivery_date: '2026-10-26' }, { start_date: '2026-11-01' }],
    ['rate change', { total: 100, is_retainer_renewal: true, revised_delivery_date: '2026-10-26' }, { start_date: '2026-11-01' }],
    ['unpriced', { total: 0, revised_delivery_date: '2026-10-26' }, { start_date: '2026-11-01' }],
  ])('silent: %s', (_n, c, p) => expect(deliveryBeforeStartWarning(c as any, p as any)).toBeNull())
})

describe('change order that never mentions revisions', () => {
  // CO-0010 as sent: nothing about revisions or changes anywhere.
  const co0010 = {
    total: 700, note: '<p>The Client\u2019s team requested help finding the right influencers and affiliate partners.</p>',
    scope_impact_note: 'Identifying influencers falls under the "Influencer partnerships" item of the "Out of Scope" section. Negotiating with, contracting and managing remain excluded.',
    line_items: [{ description: 'Identify and shortlist influencers: one shortlist of up to 10, delivered once.', quantity: 1 }],
  }
  it('warns on the real CO-0010 wording', () => expect(revisionsUnstatedWarning(co0010)).toBe(REVISIONS_UNSTATED_WARNING))
  it.each([
    'The shortlist is delivered once; changes to it need a further change order.',
    'Includes one revision round of the shortlist.',
    'Any rework of the shortlist requires a new change order.',
  ])('silent once stated: %s', t => expect(revisionsUnstatedWarning({ ...co0010, scope_impact_note: `${co0010.scope_impact_note} ${t}` })).toBeNull())
  it('"delivered once" alone does not count as a statement about changes', () => {
    expect(revisionsUnstatedWarning({ ...co0010, scope_impact_note: 'Delivered once.' })).not.toBeNull()
  })
  it('a statement in the reason note counts', () => {
    expect(revisionsUnstatedWarning({ ...co0010, note: '<p>One revision round is included.</p>' })).toBeNull()
  })
  it('stays quiet for hours and other repeated units, which the SOW already governs', () => {
    expect(revisionsUnstatedWarning({ ...co0010, line_items: [{ description: 'Extra support: up to 8 hours', quantity: 8 }] })).toBeNull()
    expect(revisionsUnstatedWarning({ ...co0010, line_items: [{ description: 'Four additional posts', quantity: 4 }] })).toBeNull()
  })
  it('fires for other work products too', () => {
    for (const d of ['A competitor report of up to 5 brands', 'A content plan for one quarter', 'One landing page design'])
      expect(revisionsUnstatedWarning({ ...co0010, line_items: [{ description: d, quantity: 1 }] })).toBe(REVISIONS_UNSTATED_WARNING)
  })
  it.each([[{ is_credit: true }], [{ is_retainer_renewal: true }], [{ total: 0 }]])('silent for %j', o => expect(revisionsUnstatedWarning({ ...co0010, ...o })).toBeNull())
})

describe('wiring and prompts', () => {
  it('CO send raises both as acknowledgeable document warnings and loads what they read', () => {
    const r = read('app/api/co/[id]/send/route.ts')
    expect(r).toContain('deliveryBeforeStartWarning(co, co.projects)')
    expect(r).toContain('revisionsUnstatedWarning(co)')
    expect(r).toContain('client_id,start_date)')
    expect(r).toContain('scope_impact_note,note,')
  })
  it('CO draft prompt asks for contents and a revisions statement', () => {
    const d = read('app/api/co/draft/route.ts')
    expect(d).toContain('says in its description what each entry or part contains')
    expect(d).toContain('scopeImpact states whether the new work includes revisions')
  })
  it('SOW drafting: brand introduced once, revision note scoped, and the access exception does not clash with the obligations rule', () => {
    const rules = draftingRulesBlock({ language: 'en', revisionNote: '1 caption revision per post', deliverables: 'monthly report with traffic data' } as unknown as SowContentInput)
    expect(rules).toContain('introduce it once, in the Project Overview, as belonging to the Client')
    expect(rules).toContain('is not covered by them and needs a change order')
    expect(rules).toContain('view-only access to where that data lives')
    expect(rules).toContain('The one exception is view-only access to the data a promised report needs')
  })
})

describe('document polish', () => {
  const r = read('lib/pdf/renderer.tsx')
  it('no stacked parentheses on the unchanged retainer line', () => {
    expect(r).toContain('Monthly retainer, unchanged{exTax}')
    expect(r).not.toContain('Monthly retainer (unchanged)')
  })
  it('a paid invoice does not repeat "Paid in full" in its footer', () => {
    expect(r).not.toContain('no further payment is due on this invoice')
    expect(r).toContain("{balanceDue > 0 ? 'Balance due' : 'Paid in full'}")
    expect(r).toContain('This is a payment record, not a payment portal')
  })
})
