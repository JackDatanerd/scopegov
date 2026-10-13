import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { invoiceLineSubtext } from '@/lib/pdf/invoice-line'
import { isGenericScopeReference, stripInternalScopeLabels, ensureCappedQuantityBasis } from '@/lib/documents/co-draft-text'
import { dedupePaymentPeriodSentences, derivedScheduleRows } from '@/lib/ai/sow-content'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('invoice line sub-text', () => {
  it('states the service period for a retainer month instead of repeating the title', () => {
    expect(invoiceLineSubtext('Monthly retainer \u2014 November 2026', 'Monthly retainer payment \u2014 November 2026')).toBe('Service period: November 1 \u2013 30, 2026')
    expect(invoiceLineSubtext('Monthly retainer \u2014 February 2028', 'Monthly retainer payment \u2014 February 2028')).toBe('Service period: February 1 \u2013 29, 2028')
  })
  it('drops a trigger that only repeats the title, keeps any other', () => {
    expect(invoiceLineSubtext('Final payment', 'final payment')).toBeNull()
    expect(invoiceLineSubtext('Final payment (50%)', 'Final delivery approval')).toBe('Final delivery approval')
    expect(invoiceLineSubtext('x', '')).toBeNull()
  })
})

describe('CO drafter backstops', () => {
  it('treats the Guardian fallback label as no reference', () => {
    expect(isGenericScopeReference('General scope')).toBe(true)
    expect(isGenericScopeReference(' general scope. ')).toBe(true)
    expect(isGenericScopeReference('Influencer partnerships')).toBe(false)
    expect(isGenericScopeReference(null)).toBe(true)
  })
  it('strips the internal label from client-facing text', () => {
    const t = 'falls under the "Influencer partnerships" item in the "Out of Scope" section (General scope) of the SOW; this change order'
    expect(stripInternalScopeLabels(t)).toBe('falls under the "Influencer partnerships" item in the "Out of Scope" section of the SOW; this change order')
    expect(stripInternalScopeLabels('No label here.')).toBe('No label here.')
  })
  it('states the billing basis of a per-unit line capped at its own quantity', () => {
    const d = 'initial message plus follow-up to each approved candidate, up to 10 candidates (one-time fee, per candidate contacted)'
    expect(ensureCappedQuantityBasis(d, 10)).toBe(`${d}; the fee covers the full quantity of 10, whether or not all are used`)
    expect(ensureCappedQuantityBasis(d, 6)).toBe(d)
    expect(ensureCappedQuantityBasis('one shortlist of up to 15 candidates', 1)).toBe('one shortlist of up to 15 candidates')
    expect(ensureCappedQuantityBasis(`${d}, billed as used`, 10)).toBe(`${d}, billed as used`)
  })
  it('wires the helpers into the drafter and gives the model the rules', () => {
    const src = read('app/api/co/draft/route.ts')
    expect(src).toContain('isGenericScopeReference(flag.sow_reference)')
    expect(src).toContain('stripInternalScopeLabels')
    expect(src).toContain('ensureCappedQuantityBasis')
    expect(src).toContain('Never write a section label the SOW does not print')
    expect(src).toContain('Never claim an exclusion lists something it does not')
  })
})

describe('payment period wording', () => {
  it('collapses "due N days of issue; ... within N days of its invoice date" to one well-formed sentence', () => {
    const html = '<p>Invoices are due 14 days of issue; each invoice is payable within 14 days of its invoice date. Work pauses on any invoice more than 7 days overdue.</p>'
    const out = dedupePaymentPeriodSentences(html, 14)
    expect(out).toBe('<p>Each invoice is payable within 14 days of its invoice date. Work pauses on any invoice more than 7 days overdue.</p>')
  })
  it('leaves a single well-formed statement untouched', () => {
    const html = '<p>Each invoice is due within 14 days of its invoice date.</p>'
    expect(dedupePaymentPeriodSentences(html, 14)).toBe(html)
  })
  it('describes the retainer instalment as invoiced in advance, not "first of month"', () => {
    const rows = derivedScheduleRows({ paymentStructure: 'monthly', contractValue: 1200, currency: 'USD', tax: { rate: 8.25, inclusive: true }, paymentTermsDays: 14 } as any)
    expect(rows[0].trigger).toContain('Invoiced monthly, in advance')
    expect(rows[0].trigger).not.toContain('first of month')
  })
})

describe('retainer invoice due date', () => {
  it('does not use a retainer row\u2019s billing-month date as the invoice due date', () => {
    const src = read('components/invoices/BillingTab.tsx')
    expect(src).toContain("m.type === 'retainer_monthly' && defaultDue ? ''")
  })
})

describe('document layout and cross-references', () => {
  const r = read('lib/pdf/renderer.tsx')
  it('keeps the last CO line with its totals and states the tax basis', () => {
    expect(r).toContain('lineItems.slice(-1)')
    expect(r).toContain('Rates and line totals include tax.')
    expect(r).toContain('Including tax ({data.taxRate}%)')
  })
  it('states the tax basis in the SOW header for retainers too, and names the SOW version a CO amends', () => {
    expect(r).not.toContain('{!data.isRetainer && (data.taxRate || 0) > 0 && (')
    expect(r).toContain('Version ${data.sowVersion}')
  })
  it('passes the SOW version to every CO document builder', () => {
    for (const f of ['app/api/pdf/co/[id]/route.ts', 'app/api/portal/co/[token]/pdf/route.ts', 'lib/documents/finalize-co.ts'])
      expect(read(f)).toContain('sowVersion')
  })
})
