import { describe, it, expect } from 'vitest'
import { parseRenewalTerm } from '@/lib/documents/renewal-term'

describe('parseRenewalTerm', () => {
  it('treats empty input as not set', () => {
    for (const v of [undefined, null, '']) expect(parseRenewalTerm(v)).toEqual({ ok: true, value: null })
  })
  it('accepts whole months 1..120, as number or numeric string', () => {
    expect(parseRenewalTerm(12)).toEqual({ ok: true, value: 12 })
    expect(parseRenewalTerm('6')).toEqual({ ok: true, value: 6 })
    expect(parseRenewalTerm(120)).toEqual({ ok: true, value: 120 })
  })
  it('rejects zero, negatives, fractions, out-of-range and junk', () => {
    for (const v of [0, -3, 1.5, 121, 'abc', NaN, {}]) expect(parseRenewalTerm(v).ok).toBe(false)
  })
})
