import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  annotateBroughtIntoScope, conformedDeliverableRows, latestRevisedDate, longDate, revisedContractValue, timelineText, type ConformedCo,
} from '@/lib/documents/conformed-sow'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const co = (over: Partial<ConformedCo> = {}): ConformedCo => ({
  number: 'CO-0013', title: 'Professional Headshot Photography', acceptedAt: '2026-10-21T10:00:00Z', netImpact: 700,
  timelineDays: 10, revisedDeliveryDate: '2027-01-07',
  scopeNote: 'This work falls under the "Professional headshots" exclusion in the "Out of Scope" section.',
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
    const oos = '<ul><li><strong>MLS/IDX integration:</strong> no connection is included.</li><li>Professional headshots: no photography of the Client is included.</li><li>Listing photography: none included.</li></ul>'
    const out = annotateBroughtIntoScope(oos, [co()])
    expect(out).toContain('Professional headshots: no photography of the Client is included. <em>Amended by CO-0013')
    expect(out).toContain('This exclusion otherwise stays in place.')
    expect(out).toContain('<li><strong>MLS/IDX integration:</strong> no connection is included.</li>')
    expect(out).toContain('<li>Listing photography: none included.</li>')
    expect(out.match(/Amended by/g)).toHaveLength(1)
  })
  it('leaves Out of Scope alone when no change order mentions an exclusion', () => {
    const oos = '<ul><li>Hosting: not included.</li></ul>'
    expect(annotateBroughtIntoScope(oos, [co()])).toBe(oos)
    expect(annotateBroughtIntoScope(oos, [])).toBe(oos)
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
