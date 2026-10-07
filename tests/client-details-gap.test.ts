import { describe, it, expect } from 'vitest'
import { clientDetailsGaps } from '@/lib/documents/client-details-gap'
import { localizeFixedCell } from '@/lib/sow/table-schema'
import { pdfChrome } from '@/lib/pdf/chrome-labels'

describe('clientDetailsGaps', () => {
  it('flags a missing address', () => {
    expect(clientDetailsGaps({ billing_address: null })).toEqual(['billing address'])
    expect(clientDetailsGaps({ billing_address: { line1: ' ', city: '' } })).toEqual(['billing address'])
  })
  it('flags a partial address', () => {
    expect(clientDetailsGaps({ billing_address: { city: 'Natchitoches' } })).toEqual(['complete billing address (street and country)'])
  })
  it('passes a complete address', () => {
    expect(clientDetailsGaps({ billing_address: { line1: '608 Front St', city: 'Natchitoches', country: 'United States' } })).toEqual([])
  })
})

describe('SOW PDF localization', () => {
  it('localizes fixed table vocabulary for display only', () => {
    expect(localizeFixedCell('owner', 'Provider', 'sw')).toBe('Wakala')
    expect(localizeFixedCell('provider', 'Yes', 'sw')).toBe('Ndiyo')
    expect(localizeFixedCell('owner', 'Provider', 'en')).toBe('Provider')
    expect(localizeFixedCell('notes', 'Yes', 'sw')).toBe('Yes')
  })
  it('falls back to English chrome for unknown languages', () => {
    expect(pdfChrome('xx').sow).toBe('Statement of Work')
    expect(pdfChrome('sw').page(1, 6)).toBe('Ukurasa 1 wa 6')
  })
})
