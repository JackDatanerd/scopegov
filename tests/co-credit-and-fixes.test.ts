import { describe, it, expect } from 'vitest'
import { computeCoTotals, parseStoredLineItems } from '@/lib/documents/co-totals'
import { coWatermarkLabel } from '@/lib/pdf/co-watermark'
import { coPdfFilename } from '@/lib/documents/co-pdf-name'
import { renewalNeedsTerm, validateCoForSend } from '@/lib/documents/send-co'

// Regression coverage for the CO logic independent re-pass (fresh clone, round 2).

describe('computeCoTotals — credit / descope mode', () => {
  it('stores entered-positive lines as a negative reduction', () => {
    const r = computeCoTotals(
      [{ description: 'Social media management (removed)', quantity: 1, rate: 500 }],
      0, false, undefined, { credit: true }
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.totals.lineItems[0].rate).toBe(-500)
    expect(r.totals.lineItems[0].total).toBe(-500)
    expect(r.totals.total).toBe(-500)
  })
  it('a negative entered rate in credit mode is still refused (only ONE sign flip, not two)', () => {
    const r = computeCoTotals([{ description: 'x', quantity: 1, rate: -50 }], 0, false, undefined, { credit: true })
    expect(r.ok).toBe(false)
  })
  it('credit mode never recognises an adjustment line, even with a valid-looking allowlist', () => {
    const r = computeCoTotals(
      [{ id: 'a1', description: 'Negotiated discount (per counter-offer)', quantity: 1, rate: 100, kind: 'adjustment' }],
      0, false, new Set(['a1']), { credit: true }
    )
    if (!r.ok) throw new Error(r.error)
    // Stored as an ordinary negative line, not tagged kind:'adjustment'.
    expect(r.totals.lineItems[0].kind).toBeUndefined()
    expect(r.totals.lineItems[0].total).toBe(-100)
  })
})

describe('computeCoTotals — bug fixes', () => {
  it('a duplicate id cannot let a second, unrelated adjustment line ride the allowlist (bug #6)', () => {
    const r = computeCoTotals([
      { id: 'a', description: 'Real work', quantity: 1, rate: 1000 },
      { id: 'adj1', description: 'Negotiated discount (per counter-offer)', quantity: 1, rate: -100, kind: 'adjustment' },
      { id: 'adj1', description: 'Totally unrelated new line', quantity: 1, rate: -500, kind: 'adjustment' },
    ], 0, false, new Set(['adj1']))
    // The second line must be re-validated as an ordinary line (negative rate refused), not silently admitted.
    expect(r.ok).toBe(false)
  })
  it('a legacy adjustment line with no kind field is still recognised and can be saved (bug #7)', () => {
    const r = computeCoTotals([
      { id: 'a', description: 'Work', quantity: 1, rate: 1000 },
      { id: 'adj1', description: 'Negotiated discount (per counter-offer)', quantity: 1, rate: -100, total: -100 },
    ], 0, false, new Set(['adj1']))
    if (!r.ok) throw new Error(r.error)
    expect(r.totals.total).toBe(900)
    expect(r.totals.lineItems[1].kind).toBe('adjustment')
  })
  it('rejects a non-numeric tax rate instead of silently treating it as 0', () => {
    const r = computeCoTotals([{ description: 'x', quantity: 1, rate: 10 }], 'garbage', false)
    expect(r.ok).toBe(false)
  })
  it('an empty string tax rate is treated as 0 (not rejected)', () => {
    const r = computeCoTotals([{ description: 'x', quantity: 1, rate: 10 }], '', false)
    expect(r.ok).toBe(true)
  })
})

describe('parseStoredLineItems', () => {
  it('parses a legacy JSON-string line_items value', () => {
    const items = parseStoredLineItems(JSON.stringify([{ description: 'x' }]))
    expect(items).toHaveLength(1)
  })
  it('returns [] for malformed JSON rather than throwing', () => {
    expect(parseStoredLineItems('{not json')).toEqual([])
  })
  it('passes an already-parsed array through unchanged', () => {
    const arr = [{ description: 'x' }]
    expect(parseStoredLineItems(arr)).toBe(arr)
  })
})

describe('renewalNeedsTerm — open-ended retainer (bug #3)', () => {
  it('does not require a term on an open-ended retainer', () => {
    const co = { is_retainer_renewal: true, renewal_term_months: null }
    const project = { type: 'retainer', retainer_duration_months: null }
    expect(renewalNeedsTerm(co, project)).toBe(false)
  })
  it('still requires a term on a fixed-length retainer', () => {
    const co = { is_retainer_renewal: true, renewal_term_months: null }
    const project = { type: 'retainer', retainer_duration_months: 12 }
    expect(renewalNeedsTerm(co, project)).toBe(true)
  })
  it('is a no-op for a non-renewal CO', () => {
    expect(renewalNeedsTerm({ is_retainer_renewal: false, renewal_term_months: null }, { type: 'retainer', retainer_duration_months: null })).toBe(false)
  })
})

describe('validateCoForSend — credit mode', () => {
  it('requires a negative total for a credit CO, not a positive one', () => {
    expect(validateCoForSend({ total: 500, lineItems: [{ description: 'x' }], isCredit: true })).toBeTruthy()
    expect(validateCoForSend({ total: -500, lineItems: [{ description: 'x' }], isCredit: true })).toBeNull()
  })
  it('still requires a positive total for an ordinary CO', () => {
    expect(validateCoForSend({ total: -500, lineItems: [{ description: 'x' }] })).toBeTruthy()
    expect(validateCoForSend({ total: 500, lineItems: [{ description: 'x' }] })).toBeNull()
  })
})

describe('coWatermarkLabel (bug #15)', () => {
  it('labels a sent-but-unsigned CO as UNSIGNED, not DRAFT', () => {
    expect(coWatermarkLabel('awaiting_response')).toBe('UNSIGNED')
    expect(coWatermarkLabel('stalled')).toBe('UNSIGNED')
  })
  it('labels withdrawn, declined, closed and exception distinctly', () => {
    expect(coWatermarkLabel('withdrawn')).toBe('WITHDRAWN')
    expect(coWatermarkLabel('declined')).toBe('DECLINED')
    expect(coWatermarkLabel('closed')).toBe('CLOSED')
    expect(coWatermarkLabel('exception_granted')).toBe('EXCEPTION')
  })
  it('an accepted CO gets no watermark label', () => {
    expect(coWatermarkLabel('accepted')).toBeNull()
  })
  it('a true draft still reads DRAFT', () => {
    expect(coWatermarkLabel('draft')).toBe('DRAFT')
  })
})

describe('coPdfFilename (bug #15)', () => {
  it('always carries the document number', () => {
    expect(coPdfFilename('CO-0042', 'Extra dev work')).toBe('CO-0042-Extra-dev-work.pdf')
  })
  it('never produces an all-dash slug for a non-ASCII title', () => {
    const name = coPdfFilename('CO-0001', 'Café rebrand — phase 2')
    expect(name).toContain('CO-0001')
    expect(name).toMatch(/Cafe/)
  })
  it('falls back to CO when there is no document number yet', () => {
    expect(coPdfFilename(null, 'Draft title')).toBe('CO-Draft-title.pdf')
  })
})
