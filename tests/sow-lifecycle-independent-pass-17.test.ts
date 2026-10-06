import { describe, it, expect } from 'vitest'
import { normalizeEnumCell, parseTableSections } from '@/lib/ai/sow-content'
import { validateSowForSend } from '@/lib/sow/validate-send'
import { sowPdfFilename } from '@/lib/documents/sow-pdf-name'

describe('SOW lifecycle pass 17', () => {
  it('B1: an empty Owner cell is Joint, matching the editor default', () => {
    expect(normalizeEnumCell('', ['Provider', 'Client', 'Joint'])).toBe('Joint')
    expect(normalizeEnumCell('Agency', ['Provider', 'Client', 'Joint'])).toBe('Provider')
    const t = parseTableSections('<<<TABLE:deliverables>>>\nLogo | OK | | Week 2\n<<<ENDTABLE>>>')
    expect(t.deliverables[0].owner).toBe('Joint')
  })

  it('B4: zero-width-only Out of Scope / Payment Terms / deliverable do not satisfy send validation', () => {
    const r = validateSowForSend({
      sections: [
        { id: 'deliverables', visible: true, table: [{ deliverable: '\u200b' }] },
        { id: 'oos', visible: true, content: '<p>\u200b</p>' },
        { id: 'payment', visible: true, content: '<p>\u200b</p>' },
      ], metadata: {}, contractValue: 100,
    })
    expect(r.errors.join(' ')).toMatch(/at least one deliverable/)
    expect(r.errors.join(' ')).toMatch(/Out of Scope/)
    expect(r.errors.join(' ')).toMatch(/Payment Terms/)
  })

  it('B5: PDF filenames survive non-Latin and missing names', () => {
    expect(sowPdfFilename('Café Rebrand!', 2)).toBe('SOW-Cafe-Rebrand-v2.pdf')
    expect(sowPdfFilename('日本語', 1, 'SOW-0007')).toBe('SOW-0007-v1.pdf')
    expect(sowPdfFilename(undefined, 1)).toBe('SOW-v1.pdf')
  })
})
