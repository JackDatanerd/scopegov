import { describe, it, expect } from 'vitest'
import { sameInstant } from '@/lib/utils/timestamps'

describe('sameInstant', () => {
  it('treats Z and +00:00 spellings of one instant as equal', () => {
    expect(sameInstant('2026-09-29T08:41:58.155Z', '2026-09-29T08:41:58.155+00:00')).toBe(true)
  })
  it('ignores sub-millisecond digits PostgREST may return', () => {
    expect(sameInstant('2026-09-29T08:41:58.155Z', '2026-09-29T08:41:58.155484+00:00')).toBe(true)
  })
  it('differs for different instants', () => {
    expect(sameInstant('2026-09-29T08:41:58.155Z', '2026-09-29T08:41:58.156Z')).toBe(false)
  })
  it('falls back to strict equality for non-dates and non-strings', () => {
    expect(sameInstant('nope', 'nope')).toBe(true)
    expect(sameInstant('nope', 'other')).toBe(false)
    expect(sameInstant(null, null)).toBe(true)
    expect(sameInstant(null, '2026-01-01T00:00:00Z')).toBe(false)
  })
})
