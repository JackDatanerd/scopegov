import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { dedupePaymentPeriodSentences, buildSowContentPrompt, draftingRulesBlock } from '@/lib/ai/sow-content'
import { stripPerUseBilling, ensureCappedQuantityBasis, normalizeLineEnding, scrubProjectNameAsBrand } from '@/lib/documents/co-draft-text'
import { mapPdfSymbols } from '@/lib/pdf/pdf-symbols'
import { findClientDateConflicts, datesIn } from '@/lib/sow/date-conflicts'
import { validateSowForSend } from '@/lib/sow/validate-send'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('payment period wording keeps its label', () => {
  it('keeps the bold "Payment period." lead when the badly worded clause is replaced', () => {
    const out = dedupePaymentPeriodSentences('<p><strong>Payment period.</strong> Invoices are due 14 days of issue; each invoice is payable within 14 days of its invoice date. Work pauses on any invoice more than 7 days overdue.</p>', 14)
    expect(out).toBe('<p><strong>Payment period.</strong> Each invoice is payable within 14 days of its invoice date. Work pauses on any invoice more than 7 days overdue.</p>')
  })
  it('still works without a lead', () => {
    expect(dedupePaymentPeriodSentences('<p>Invoices are due 14 days of issue; each invoice is payable within 14 days of its invoice date.</p>', 14))
      .toBe('<p>Each invoice is payable within 14 days of its invoice date.</p>')
  })
})

describe('capped-quantity lines no longer contradict themselves', () => {
  const v6 = 'Initial outreach: one round of introductory outreach messages to up to 10 shortlisted influencer or affiliate candidates selected by the Client, fee per candidate contacted. One-time fee; excludes negotiation, contracting, and follow-up rounds.'
  it('removes the per-use phrase and states the fixed basis once', () => {
    const out = ensureCappedQuantityBasis(v6, 10)
    expect(out).not.toMatch(/per candidate contacted/i)
    expect(out).toContain('selected by the Client. One-time fee; excludes negotiation, contracting, and follow-up rounds; the fee covers the full quantity of 10, whether or not all are used')
  })
  it('handles the parenthesised form', () => {
    expect(stripPerUseBilling('outreach, up to 10 candidates (one-time fee, per candidate contacted)')).toBe('outreach, up to 10 candidates (one-time fee)')
    expect(stripPerUseBilling('up to 10 candidates, billed per candidate used')).toBe('up to 10 candidates')
  })
  it('leaves other per-unit wording alone', () => {
    expect(stripPerUseBilling('USD per candidate shortlisted, up to 15')).toBe('USD per candidate shortlisted, up to 15')
  })
  it('line descriptions end consistently', () => {
    expect(normalizeLineEnding('One-time fee covering the full shortlist.')).toBe('One-time fee covering the full shortlist')
    expect(normalizeLineEnding('Already clean')).toBe('Already clean')
  })
})

describe('the internal project name is never the brand', () => {
  it('rewrites "<project> brand" to the Client\u2019s brand', () => {
    expect(scrubProjectNameAsBrand('identify suitable influencers for the V6 DTC Skincare brand. The Provider will', 'V6 DTC Skincare'))
      .toBe("identify suitable influencers for the Client's brand. The Provider will")
    expect(scrubProjectNameAsBrand('Project V6 DTC Skincare is amended', 'V6 DTC Skincare')).toBe('Project V6 DTC Skincare is amended')
    expect(scrubProjectNameAsBrand('anything', '')).toBe('anything')
  })
  it('the drafter is told the project name is an internal label', () => {
    const src = read('app/api/co/draft/route.ts')
    expect(src).toContain('an internal label: never print it as the name of the Client')
    expect(src).toContain('scrubProjectNameAsBrand')
    expect(src).toContain('Say a requested activity falls under an exclusion only if the exclusion')
    expect(src).toContain('Draft line items only for work the Client')
  })
})

describe('one apostrophe style per document', () => {
  it('draws apostrophes between letters curly, in every string, and leaves URIs alone', () => {
    const out = mapPdfSymbols({ a: "Client's and mediator's", b: 'Provider\u2019s', c: 'data:image/png;base64,ab\'cd', d: 'https://x.test/o\'neil', e: "'quoted'" }) as any
    expect(out.a).toBe('Client\u2019s and mediator\u2019s')
    expect(out.b).toBe('Provider\u2019s')
    expect(out.c).toContain("ab'cd")
    expect(out.d).toContain("o'neil")
    expect(out.e).toBe("'quoted'")
  })
})

describe('a client dependency has one date', () => {
  const merged = [{ deliverable: 'Account access and raw UGC footage', acceptanceCriteria: 'Account access and Shopify analytics access granted to Provider, and raw UGC footage supplied in sufficient volume for 6 posts per week', owner: 'Client', targetDate: 'November 1, 2026' }]
  const assumptions = '<ul><li>The Client will provide Provider with access to the Solvane TikTok and Instagram accounts and to the Client\'s Shopify analytics by November 1, 2026.</li><li>The Client will supply raw UGC footage by November 8, 2026 for the initial posting period, and thereafter in sufficient volume.</li></ul>'
  it('parses both date orders', () => {
    expect(datesIn('by November 8, 2026 and 3 Dec')).toEqual(['11-8', '12-3'])
  })
  it('flags the merged row from the V6 SOW', () => {
    const c = findClientDateConflicts(merged, assumptions)
    expect(c).toHaveLength(1)
    expect(c[0]).toContain('Account access and raw UGC footage')
    expect(c[0]).toContain('November 8, 2026')
  })
  it('accepts separate rows that each match their own assumption', () => {
    const rows = [
      { deliverable: 'Access to social accounts and Shopify analytics', acceptanceCriteria: 'Provider given access to the accounts', owner: 'Client', targetDate: 'November 3, 2026' },
      { deliverable: 'Client-provided raw UGC footage (initial batch)', acceptanceCriteria: 'Initial batch of raw UGC footage delivered', owner: 'Client', targetDate: 'November 8, 2026' },
    ]
    expect(findClientDateConflicts(rows, assumptions.replace('November 1, 2026', 'November 3, 2026'))).toEqual([])
  })
  it('ignores Provider rows, cadence cells and undated rows', () => {
    expect(findClientDateConflicts([{ deliverable: 'Posts', owner: 'Provider', targetDate: 'Weekly' }], assumptions)).toEqual([])
    expect(findClientDateConflicts([{ deliverable: 'UGC footage', owner: 'Client', targetDate: 'Weekly' }], assumptions)).toEqual([])
    expect(findClientDateConflicts(null, null)).toEqual([])
  })
  it('send validation warns, and generation retries once with the conflict spelled out', () => {
    const r = validateSowForSend({
      sections: [
        { id: 'deliverables', visible: true, content: '', table: merged },
        { id: 'assumptions', visible: true, content: assumptions },
        { id: 'oos', visible: true, content: '<p>None</p>' },
        { id: 'payment', visible: true, content: '<p>USD 1,000.00</p>' },
      ], metadata: { paymentStructure: '50_50' }, contractValue: 1000,
    } as any)
    expect(r.warnings.join(' ')).toContain('one Client date')
    const g = read('app/api/sow/generate/route.ts')
    expect(g).toContain('findClientDateConflicts(aiTables?.deliverables')
    expect(g).toContain('fixNote: fixNote || undefined')
    expect(g).toContain('conflictingDraft')
  })
  it('the drafting rules ask for one row per client item', () => {
    expect(draftingRulesBlock({ language: 'en', dateStyle: 'us' } as any)).toContain('gets its OWN row in the Deliverables table')
    expect(buildSowContentPrompt({ language: 'en', currency: 'USD', contractValue: 1000, paymentStructure: '50_50' } as any, { fixNote: 'X vs Y' })).toContain('FIX REQUIRED')
  })
})

describe('retainer SOW header and invoice labels', () => {
  const r = read('lib/pdf/renderer.tsx')
  it('puts the tax basis directly under the price label, above the SIGNED badge', () => {
    const label = r.indexOf("{data.isRetainer ? t.monthlyRetainer : t.contractValue}")
    const tax = r.indexOf('t.inclTax(data.taxRate as number)')
    const badge = r.indexOf("{t.signed}</Text>\n            )}")
    expect(label).toBeGreaterThan(0)
    expect(tax).toBeGreaterThan(label)
    expect(badge).toBeGreaterThan(tax)
  })
  it('names the invoice\u2019s tax-inclusive paid figure so it cannot be confused with the excl.-tax one', () => {
    expect(r).toContain("Paid to date{(data.taxRate || 0) > 0 ? ' (incl. tax)' : ''}")
  })
  it('tells the model a retainer fee\u2019s tax basis in the overview format', () => {
    const src = read('lib/ai/sow-content.ts')
    expect(src).toContain("per month${input.tax && input.tax.rate > 0 ? (input.tax.inclusive ? ', tax included' : ', excluding tax') : ''}")
  })
})

describe('settings', () => {
  it('shows the review window always, and the consequence as its own choice', () => {
    const c = read('components/settings/SettingsClient.tsx')
    expect(c).toContain('Client review window')
    expect(c).toContain('If the client doesn&apos;t respond within it')
    expect(c).not.toContain("set('defaultApprovalDays', v === 'deemed_approved' ? (form.defaultApprovalDays || '5') : '')")
  })
})
