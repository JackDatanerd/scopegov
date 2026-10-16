import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { retainerPaymentTermsHtml, leadLateFeeParagraph, ensureChangeOrderClause, agencyPaymentTermsText, draftingRulesBlock, lawWithArticle, type SowContentInput } from '@/lib/ai/sow-content'
import { fixOutOfScopePhrasing, } from '@/lib/documents/co-draft-text'
import { disputeClauseHtml } from '@/lib/documents/standard-clauses'
import { validateSowForSend } from '@/lib/sow/validate-send'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const v8 = (over: Partial<SowContentInput> = {}): SowContentInput => ({
  language: 'en', currency: 'USD', contractValue: 1200, retainer: { months: null }, tax: { rate: 8.25, inclusive: true },
  startDate: '2026-11-01', dateStyle: 'us', paymentTermsDays: 14, lateFeeRate: 2.7, ...over,
} as unknown as SowContentInput)
const leads = (html: string) => [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map(m => m[1])

describe('retainer Payment Terms are written by the app', () => {
  it('fixed labels in a fixed order, every fact from data (V8 inputs)', () => {
    const html = retainerPaymentTermsHtml(v8(), 'Work pauses on any invoice more than 7 days overdue.')
    expect(leads(html)).toEqual(['Monthly retainer fee.', 'Retainer term.', 'Billing.', 'Sales tax.', 'Payment period.', 'Late payment.', 'Suspension of work.'])
    expect(html).toContain('recurring retainer fee of USD 1,200.00 per month, tax included')
    expect(html).toContain('open-ended and is billed monthly until either party ends it in writing')
    expect(html).toContain('first invoice issued before work commences on November 1, 2026')
    expect(html).toContain('each monthly fee of USD 1,200.00 includes USD 91.45 of tax (net USD 1,108.55)')
    expect(html).toContain('Each invoice is due within 14 days of its invoice date.')
    expect(html).toContain('late fee of 2.7% per month')
    expect(html).toContain('Work pauses on any invoice more than 7 days overdue.')
  })
  it('is identical on every call for the same inputs', () => {
    expect(retainerPaymentTermsHtml(v8())).toBe(retainerPaymentTermsHtml(v8()))
  })
  it('handles a fixed term, exclusive tax, no tax, and omits what has no data', () => {
    expect(retainerPaymentTermsHtml(v8({ retainer: { months: 6 } as any }))).toContain('runs for 6 months')
    const ex = retainerPaymentTermsHtml(v8({ tax: { rate: 8.25, inclusive: false } as any }))
    expect(ex).toContain('plus sales tax')
    expect(ex).toContain('exclusive of sales tax')
    const bare = retainerPaymentTermsHtml(v8({ tax: null, paymentTermsDays: null, lateFeeRate: null, startDate: null } as any))
    expect(leads(bare)).toEqual(['Monthly retainer fee.', 'Retainer term.', 'Billing.'])
    expect(bare).not.toContain('commences on')
  })
  it('keeps the agency\u2019s own terms: suspension labelled, others under Additional terms, repeats skipped', () => {
    const html = retainerPaymentTermsHtml(v8(), 'Work pauses on any invoice more than 7 days overdue. Expenses are billed at cost. Each invoice is due within 14 days of its invoice date.')
    expect(leads(html).slice(-2)).toEqual(['Suspension of work.', 'Additional terms.'])
    expect(html).toContain('Expenses are billed at cost.')
    expect((html.match(/due within 14 days/g) || []).length).toBe(1)
  })
  it('only for English retainers', () => {
    expect(retainerPaymentTermsHtml(v8({ language: 'fr' }))).toBe('')
    expect(retainerPaymentTermsHtml(v8({ retainer: null } as any))).toBe('')
    expect(retainerPaymentTermsHtml(v8({ contractValue: 0 }))).toBe('')
  })
  it('agencyPaymentTermsText reads the saved standard', () => {
    expect(agencyPaymentTermsText({ paymentTerms: 'Net terms apply.' } as any)).toContain('Net terms apply.')
    expect(agencyPaymentTermsText(null)).toBe('')
  })
})

describe('other payment structures keep model text but get consistent labels', () => {
  const late = 'Amounts not paid by their due date accrue a late fee of 2.7% per month until paid, or the maximum rate permitted by applicable law if lower.'
  it('adds the lead to a bare late-fee paragraph among labelled ones', () => {
    const out = leadLateFeeParagraph(`<p><strong>Payment terms.</strong> Due in 14 days.</p><p>${late}</p>`, v8())
    expect(out).toContain('<p><strong>Late payment.</strong> Amounts not paid')
  })
  it('leaves unlabelled sections and already labelled paragraphs alone', () => {
    const bare = `<p>Due in 14 days.</p><p>${late}</p>`
    expect(leadLateFeeParagraph(bare, v8())).toBe(bare)
    const led = `<p><strong>Late payment.</strong> ${late}</p><p><strong>X.</strong> y</p>`
    expect(leadLateFeeParagraph(led, v8())).toBe(led)
  })
})

describe('Out of Scope names the change-order route', () => {
  it('appends the fixed sentence when missing, never twice, never to an empty section', () => {
    const out = ensureChangeOrderClause('<ul><li>Paid ads</li></ul>', v8())
    expect(out).toContain('Any of these items may be performed only under a written change order signed by both parties.')
    expect(ensureChangeOrderClause(out, v8())).toBe(out)
    expect(ensureChangeOrderClause('<p>Items are excluded; add them by change order.</p>', v8())).toBe('<p>Items are excluded; add them by change order.</p>')
    expect(ensureChangeOrderClause('', v8())).toBe('')
    expect(ensureChangeOrderClause('<ul><li>x</li></ul>', v8({ language: 'es' }))).toBe('<ul><li>x</li></ul>')
  })
})

describe('Dispute Resolution reads the jurisdiction like Governing Law', () => {
  it('has "the" before a State', () => {
    expect(disputeClauseHtml(lawWithArticle('State of Texas, United States'))).toContain('the competent courts of the State of Texas, United States')
    expect(disputeClauseHtml(lawWithArticle('England and Wales'))).toContain('the competent courts of England and Wales')
  })
  it('the route passes the phrase through lawWithArticle', () => {
    expect(read('app/api/sow/generate/route.ts')).toContain('disputeClauseHtml(lawWithArticle(contentInput.governingLaw))')
  })
})

describe('CO scope wording', () => {
  it('rewrites "falls outside the Out of Scope section" to "falls under"', () => {
    expect(fixOutOfScopePhrasing('This work falls outside the "Out of Scope" section: identifying influencers is named.'))
      .toBe('This work falls under the "Out of Scope" section: identifying influencers is named.')
    expect(fixOutOfScopePhrasing('falls outside of the \u201cOut of Scope\u201d section')).toBe('falls under the \u201cOut of Scope\u201d section')
    expect(fixOutOfScopePhrasing('This falls outside the signed Deliverables.')).toBe('This falls outside the signed Deliverables.')
  })
  it('the drafter no longer teaches the inverted phrase', () => {
    const src = read('app/api/co/draft/route.ts')
    expect(src).toContain('fixOutOfScopePhrasing(')
    expect(src).toContain('falls UNDER that section')
    expect(src).not.toContain('how this work sits outside the signed scope')
  })
})

describe('client obligations stay within the brief', () => {
  it('is in the drafting rules', () => {
    expect(draftingRulesBlock({ language: 'en', dateStyle: 'us' } as any)).toContain('Never add other Client obligations such as brand assets')
  })
})

describe('deferred review period is flagged before sending', () => {
  const base = (revisions: string, metadata: any) => validateSowForSend({
    sections: [
      { id: 'deliverables', visible: true, content: '', table: [{ deliverable: 'Posts', owner: 'Provider', targetDate: 'Weekly' }] },
      { id: 'oos', visible: true, content: '<p>None</p>' },
      { id: 'payment', visible: true, content: '<p>USD 1,000.00</p>' },
      { id: 'revisions', visible: true, content: revisions },
    ], metadata, contractValue: 1000,
  } as any)
  it('warns when the window is deferred and none is set', () => {
    const r = base('<p>The review and feedback period is agreed in writing before work begins.</p>', { paymentStructure: '50_50' })
    expect(r.warnings.join(' ')).toContain('client review period')
  })
  it('is quiet once a window is set or the policy states one', () => {
    expect(base('<p>agreed in writing before work begins</p>', { paymentStructure: '50_50', approvalSilence: { mode: null, days: 3 } }).warnings.join(' ')).not.toContain('client review period')
    expect(base('<p>Feedback within 3 business days.</p>', { paymentStructure: '50_50' }).warnings.join(' ')).not.toContain('client review period')
  })
})

describe('CO table header repeats on a continued page', () => {
  it('is a fixed row inside the table\u2019s own section (react-pdf repeats it only where the table continues)', () => {
    expect(read('lib/pdf/renderer.tsx')).toContain('<View style={s.tableHdr} fixed>')
  })
  it('the generator uses the app-written retainer terms, the late-fee lead and the change-order sentence', () => {
    const g = read('app/api/sow/generate/route.ts')
    expect(g).toContain('retainerPaymentTermsHtml(contentInput, agencyPaymentTermsText(standards))')
    expect(g).toContain('leadLateFeeParagraph(allContent.payment, contentInput)')
    expect(g).toContain("ensureChangeOrderClause(allContent.oos || '', contentInput)")
  })
})
