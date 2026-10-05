// tests/settings-independent-pass-13.test.ts
//
// Settings independent pass 13: standard terms made only of invisible characters (zero-width space, word joiner,
// Hangul filler...) were stored and then appended to client-facing SOWs as an empty bullet / paragraph.
import { describe, it, expect } from 'vitest'
import { parseStandardsInput, pickAgencyStandards } from '@/lib/utils/agency-standards'
import { applyAgencyStandards, standardsPromptBlock } from '@/lib/ai/sow-content'

const ZW = '\u200b\u200b'
const WJ = '\u2060'
const FILLER = '\u3164'

describe('parseStandardsInput — invisible-only text is blank', () => {
  it('stores invisible-only wording as an explicit blank, not as text', () => {
    const r = parseStandardsInput({ revisionPolicy: ZW, paymentTerms: WJ })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.values.revision_policy).toBe('')
      expect(r.values.payment_terms).toBe('')
    }
  })

  it('drops invisible-only list items but keeps real ones', () => {
    const r = parseStandardsInput({ outOfScopeClauses: [ZW, 'Hosting', FILLER], assumptions: [FILLER] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.values.out_of_scope_clauses).toEqual(['Hosting'])
      expect(r.values.assumptions).toEqual([])
    }
  })

  it('still preserves null (inherit) and real wording', () => {
    const r = parseStandardsInput({ revisionPolicy: null, paymentTerms: 'Net 14.' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.values.revision_policy).toBeNull()
      expect(r.values.payment_terms).toBe('Net 14.')
    }
  })
})

describe('SOW generation ignores invisible-only standards already stored', () => {
  const legacy = {
    revisionPolicy: ZW, paymentTerms: WJ, outOfScopeClauses: [ZW, FILLER], assumptions: [FILLER],
  }

  it('pickAgencyStandards treats them as no standards at all', () => {
    expect(pickAgencyStandards([{ project_type: null, revision_policy: ZW, payment_terms: WJ, out_of_scope_clauses: [ZW], assumptions: [FILLER] }], 'web')).toBeNull()
  })

  it('applyAgencyStandards appends nothing', () => {
    const content = { oos: '<ul><li>Hosting</li></ul>', assumptions: '<p>None.</p>', revisions: '<p>Two rounds.</p>', payment: '<p>50/50.</p>' }
    expect(applyAgencyStandards(content, legacy, 2)).toEqual(content)
  })

  it('the model prompt gets no blank bullets', () => {
    expect(standardsPromptBlock(legacy)).toBe('')
  })

  it('real standards are still applied', () => {
    const out = applyAgencyStandards({ oos: '', assumptions: '', revisions: '', payment: '' }, { outOfScopeClauses: [ZW, 'Hosting fees'] }, 2)
    expect(out.oos).toBe('<ul><li>Hosting fees</li></ul>')
  })
})
