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

import { validateSowForSend } from '@/lib/sow/validate-send'
describe('send warnings: governing law and past start date', () => {
  const base = {
    sections: [
      { id: 'overview', visible: true, content: '<p>x</p>' }, { id: 'parties', visible: true, content: '<p>p</p>' },
      { id: 'signature', visible: true, content: '<p>s</p>' },
      { id: 'governing_law', visible: true, content: '<p>This Agreement is governed by the laws of United States.</p>' },
    ],
    metadata: {}, contractValue: 100, today: '2026-10-07',
  }
  it('warns when governing law names only the country', () => {
    expect(validateSowForSend(base as any).warnings.join(' ')).toMatch(/Governing Law/)
  })
  it('does not warn for a named state', () => {
    const s = { ...base, sections: base.sections.map(x => x.id === 'governing_law' ? { ...x, content: '<p>governed by the laws of the State of Florida.</p>' } : x) }
    expect(validateSowForSend(s as any).warnings.join(' ')).not.toMatch(/Governing Law/)
  })
  it('warns on a start date in the past only', () => {
    expect(validateSowForSend({ ...base, projectStartDate: '2026-06-16' } as any).warnings.join(' ')).toMatch(/start date/)
    expect(validateSowForSend({ ...base, projectStartDate: '2026-12-01' } as any).warnings.join(' ')).not.toMatch(/start date/)
  })
})
