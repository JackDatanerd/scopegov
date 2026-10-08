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

describe('governing law warning from the workspace setting (any drafting language)', () => {
  const sections = [
    { id: 'overview', visible: true, content: '<p>x</p>' }, { id: 'parties', visible: true, content: '<p>p</p>' },
    { id: 'signature', visible: true, content: '<p>s</p>' },
    { id: 'governing_law', visible: true, content: '<p>Makubaliano haya yanaongozwa na sheria za United States.</p>' },
  ]
  it('warns for a bare country setting even when the clause is Swahili', () => {
    const w = validateSowForSend({ sections, metadata: {}, contractValue: 100, workspaceGoverningLaw: 'United States' } as any).warnings.join(' ')
    expect(w).toMatch(/Governing Law/)
  })
  it('does not warn for a state-level setting', () => {
    const w = validateSowForSend({ sections, metadata: {}, contractValue: 100, workspaceGoverningLaw: 'State of Florida, United States' } as any).warnings.join(' ')
    expect(w).not.toMatch(/Governing Law/)
  })
})

import { agencyDetailsGaps } from '@/lib/documents/client-details-gap'
describe('agencyDetailsGaps (the sender\'s own details)', () => {
  const addr = { line1: '244 Franklin Blvd', city: 'St George Island', country: 'United States' }
  it('flags a new workspace with no address and no signature on a SOW', () => {
    const g = agencyDetailsGaps({ legal_address: null, agency_signature_data: null }, 'sow')!
    expect(g.missing).toEqual(['business address', 'agency signature'])
    expect(g.fixes.map(f => f.url)).toEqual(['/settings?tab=workspace', '/settings?tab=branding'])
  })
  it('does not ask for a signature on an invoice', () => {
    expect(agencyDetailsGaps({ legal_address: null }, 'invoice')!.missing).toEqual(['business address'])
    expect(agencyDetailsGaps({ legal_address: addr }, 'invoice')).toBeNull()
  })
  it('passes once address, signature and signatory name exist', () => {
    expect(agencyDetailsGaps({ legal_address: addr, agency_signature_data: 'data:image/png;base64,AAAA', agency_signatory_name: 'Jane Doe' }, 'co')).toBeNull()
  })
  it('asks for a signatory name when a signature exists without one', () => {
    const g = agencyDetailsGaps({ legal_address: addr, agency_signature_data: 'data:image/png;base64,AAAA' }, 'sow')!
    expect(g.missing).toEqual(['signatory name'])
    expect(agencyDetailsGaps({ legal_address: addr, agency_signature_data: 'x' }, 'invoice')).toBeNull()
  })
  it('treats a street-only address as incomplete', () => {
    expect(agencyDetailsGaps({ legal_address: { line1: 'x' }, agency_signature_data: 'd', agency_signatory_name: 'J' }, 'sow')!.missing).toEqual(['business address'])
  })
})
