import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  amendedExclusionTitles, annotateBroughtIntoScope, conformedDeliverableRows, conformedPaymentScheduleRows, latestRevisedDate, longDate,
  overviewAmendmentNote, paymentAmendmentNote, revisedContractValue, timelineText, type ConformedCo,
} from '@/lib/documents/conformed-sow'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const co = (over: Partial<ConformedCo> = {}): ConformedCo => ({
  number: 'CO-0013', title: 'Professional Headshot Photography', acceptedAt: '2026-10-21T10:00:00Z', netImpact: 700,
  timelineDays: 10, revisedDeliveryDate: '2027-01-07',
  // The real Impact Analysis text of CO-0013, including the sentences that mention listing photography and what stays in place.
  scopeNote: 'This work falls under the "Professional headshots" exclusion in the "Out of Scope" section, which states that no photography of the Client or any individual is included. This change order brings that work into scope by amending that exclusion, for the headshot photography described here only; every other exclusion in the "Out of Scope" section stays in place. The headshots are delivered once and do not include revisions; any changes to them would need a further change order. Any third-party costs, such as studio or location hire, are borne by the Client and are not part of the Provider\'s fee. This change order does not include listing photography or photography of any individual other than the Client.',
  addedDeliverables: ['Professional headshot photography session for one individual', 'Selection, retouching and delivery of up to 10 headshot images'],
  removedDeliverables: [], isRenewal: false, ...over,
})

describe('amended copy of a signed SOW', () => {
  it('adds the contract value and picks the latest revised date', () => {
    expect(revisedContractValue(4000, [co()])).toBe(4700)
    expect(revisedContractValue(4000, [co(), co({ netImpact: -250.5 })])).toBe(4449.5)
    expect(revisedContractValue(4000, [co({ isRenewal: true, netImpact: 999 })])).toBe(4000)
    expect(latestRevisedDate([co(), co({ revisedDeliveryDate: '2027-02-01' }), co({ revisedDeliveryDate: null })])).toBe('2027-02-01')
    expect(latestRevisedDate([co({ revisedDeliveryDate: null })])).toBeNull()
  })
  it('formats dates in UTC so the day never shifts', () => {
    expect(longDate('2027-01-07')).toBe('January 7, 2027')
    expect(longDate('')).toBe('')
    expect(timelineText(co())).toBe('+10 days, delivery January 7, 2027')
    expect(timelineText(co({ timelineDays: null, revisedDeliveryDate: null }))).toBe('No change')
  })
  it('appends added deliverables, marked with the change order, and never mutates the signed rows', () => {
    const signed = [{ deliverable: 'Logo + variations', acceptanceCriteria: 'x', owner: 'Provider', targetDate: 'November 30, 2026' }]
    const frozen = JSON.stringify(signed)
    const rows = conformedDeliverableRows(signed, [co()])
    expect(JSON.stringify(signed)).toBe(frozen)
    expect(rows).toHaveLength(3)
    expect(rows[1].acceptanceCriteria).toContain('Added by CO-0013')
    expect(rows[1].targetDate).toBe('January 7, 2027')
  })
  it('does not duplicate a deliverable already listed, and notes a removed one', () => {
    const signed = [{ deliverable: 'Printed brochures', owner: 'Provider' }, { deliverable: 'Logo', owner: 'Provider' }]
    const rows = conformedDeliverableRows(signed, [co({ addedDeliverables: ['logo'], removedDeliverables: ['Printed brochures'] })])
    expect(rows).toHaveLength(2)
    expect(rows[0].deliverable).toBe('Printed brochures (removed by CO-0013)')
  })
  it('marks only the exclusion the change order names, and says the rest stays in place', () => {
    const oos = '<ul><li><strong>MLS/IDX integration:</strong> no connection is included.</li><li>Professional headshots: no photography of the Client or any individual is included.</li><li>Listing photography: no photography of properties or listings is included.</li><li>Printing costs: not included.</li></ul>'
    const out = annotateBroughtIntoScope(oos, [co()])
    expect(out).toContain('Professional headshots: no photography of the Client or any individual is included. <em>Amended by CO-0013')
    expect(out).toContain('This exclusion otherwise stays in place.')
    expect(out).toContain('<li><strong>MLS/IDX integration:</strong> no connection is included.</li>')
    // Regression (SOW-0014 amended copy): the change order says it does NOT include listing photography. It must never be marked as lifted.
    expect(out).toContain('<li>Listing photography: no photography of properties or listings is included.</li>')
    expect(out).toContain('<li>Printing costs: not included.</li>')
    expect(out.match(/Amended by/g)).toHaveLength(1)
  })
  it('only a quoted title in a sentence that amends counts', () => {
    expect(amendedExclusionTitles(co().scopeNote)).toEqual(['professional headshots'])
    expect(amendedExclusionTitles('This change order does not include "Listing photography".')).toEqual([])
    expect(amendedExclusionTitles('The "Hosting" exclusion stays in place.')).toEqual([])
    expect(amendedExclusionTitles('This brings the \u201cProfessional headshots\u201d exclusion into scope.')).toEqual(['professional headshots'])
    expect(amendedExclusionTitles('Headshots are now in scope.')).toEqual([])
    expect(amendedExclusionTitles(null)).toEqual([])
  })
  it('marks nothing when the change order quotes no exclusion', () => {
    const oos = '<ul><li>Professional headshots: none included.</li></ul>'
    expect(annotateBroughtIntoScope(oos, [co({ scopeNote: 'Headshots are now in scope.' })])).toBe(oos)
  })
  it('leaves Out of Scope alone when no change order mentions an exclusion', () => {
    const oos = '<ul><li>Hosting: not included.</li></ul>'
    expect(annotateBroughtIntoScope(oos, [co()])).toBe(oos)
    expect(annotateBroughtIntoScope(oos, [])).toBe(oos)
  })
})

describe('the amended body no longer contradicts the revised header', () => {
  const ctx = { currency: 'USD', taxRate: 8.25 }
  it('says what the contract value and delivery date are now, under Project Overview', () => {
    const n = overviewAmendmentNote([co()], { currency: 'USD', revisedNet: 4700, revisedDate: '2027-01-07' })
    expect(n).toContain('Amended by CO-0013')
    expect(n).toContain('USD 4,700.00 (excluding sales tax)')
    expect(n).toContain('January 7, 2027')
    expect(n).toContain('as originally signed')
  })
  it('states the added fee and its tax under Payment Terms, and skips fee-neutral and renewal change orders', () => {
    const n = paymentAmendmentNote([co(), co({ number: 'CO-0014', netImpact: 0 }), co({ number: 'CO-0015', isRenewal: true })], ctx)
    expect(n).toContain('an additional fee of USD 700.00 plus 8.25% sales tax (USD 57.75)')
    expect(n).not.toContain('CO-0014')
    expect(n).not.toContain('CO-0015')
    expect(paymentAmendmentNote([co({ netImpact: -100 })], { currency: 'USD', taxRate: null })).toContain('a credit of USD 100.00, invoiced separately')
  })
  it('adds a Payment Schedule row per fee-changing change order without touching the signed rows', () => {
    const signed = [{ milestone: 'Upfront Payment (50%)', amount: 'USD 2,000.00', trigger: 'Before work commences' }]
    const frozen = JSON.stringify(signed)
    const rows = conformedPaymentScheduleRows(signed, [co()], ctx)
    expect(JSON.stringify(signed)).toBe(frozen)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ milestone: 'CO-0013: Professional Headshot Photography', amount: 'USD 700.00' })
    expect(String(rows[1].trigger)).toContain('+ 8.25% tax (USD 57.75)')
  })
})

describe('the amended copy is read-only and separate from the signed SOW', () => {
  const route = read('app/api/pdf/sow/[id]/amended/route.ts')
  it('only ever reads, and refuses an unsigned SOW', () => {
    expect(route).toContain("sow.status !== 'signed'")
    expect(route).not.toMatch(/\.(insert|update|delete|upsert)\(/)
    expect(route).not.toContain('pdf_path')
  })
  it('is never served from, or stored as, the frozen executed copy', () => {
    expect(route).not.toContain('fetchExecutedPdf')
    expect(route).toContain("watermarkText: 'AMENDED COPY'")
  })
  it('the signed SOW route is unchanged and still serves the frozen copy', () => {
    const signed = read('app/api/pdf/sow/[id]/route.ts')
    expect(signed).toContain('fetchExecutedPdf')
    expect(signed).not.toContain('amended')
  })
})
