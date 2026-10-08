import { describe, it, expect } from 'vitest'
import { SOW_LANGUAGE_NAMES, buildFallbackSections } from '@/lib/ai/sow-content'
import { pdfChrome } from '@/lib/pdf/chrome-labels'
import { localizeFixedCell, toBeDefinedLabel } from '@/lib/sow/table-schema'

const OTHER = Object.keys(SOW_LANGUAGE_NAMES).filter(l => l !== 'en')
// Words that are legitimately identical to English in some languages.
const SAME_OK = new Set(['version', 'vat', 'client', 'clientLabel', 'total'])

describe('every non-English SOW language is fully covered', () => {
  it('has PDF chrome for each language', () => {
    const en = pdfChrome('en') as any
    for (const l of OTHER) {
      const t = pdfChrome(l) as any
      for (const k of Object.keys(en)) {
        if (typeof en[k] !== 'string' || SAME_OK.has(k)) continue
        expect(t[k], `${l}.${k}`).not.toBe(en[k])
      }
      expect(t.page(2, 5)).toMatch(/2/)
    }
  })
  it('localizes fixed table vocabulary and placeholders', () => {
    for (const l of OTHER) {
      expect(localizeFixedCell('owner', 'Provider', l), l).not.toBe('Provider')
      expect(localizeFixedCell('client', 'Yes', l), l).not.toBe('Yes')
      expect(toBeDefinedLabel(l), l).not.toBe('To be defined')
    }
  })
  it('prints the payment structure in the drafting language (fallback text)', () => {
    for (const l of OTHER) {
      const html = buildFallbackSections({
        agencyName: 'A', clientName: 'C', projectName: 'P', projectType: 'x', contractValue: 100, currency: 'USD',
        paymentLabel: 'Payable in milestones as defined below', paymentStructure: 'milestones', revisionRounds: 2,
        governingLaw: 'State of Florida', language: l,
      } as any).payment
      expect(html, l).not.toContain('Payable in milestones')
    }
  })
})
