// tests/co-truncate-surrogate.test.ts
//
// Section-10 fresh pass: capped free-text fields were cut with String.slice, which counts UTF-16 units. A cap that
// lands inside an emoji left a lone high surrogate; that is not valid in the JSON body sent to Postgres, so the
// create/save failed with a generic error for text that looked fine. truncateText never splits a pair.

import { describe, it, expect } from 'vitest'
import { truncateText, cleanTextField } from '@/lib/utils/sanitize'
import { parseCoFields, MAX_CO_TITLE_LENGTH, MAX_CO_SCOPE_NOTE_LENGTH } from '@/lib/documents/co-input'

const isWellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('truncateText', () => {
  it('leaves short text alone', () => expect(truncateText('hello', 10)).toBe('hello'))
  it('cuts plain text at the cap', () => expect(truncateText('abcdef', 3)).toBe('abc'))
  it('does not strand half an emoji', () => {
    const out = truncateText('a'.repeat(199) + '😀tail', 200)
    expect(out).toBe('a'.repeat(199))
    expect(isWellFormed(out)).toBe(true)
  })
  it('keeps a pair that fits exactly', () => {
    const out = truncateText('a'.repeat(198) + '😀tail', 200)
    expect(out.endsWith('😀')).toBe(true)
    expect(out.length).toBe(200)
  })
  it('handles empty / nullish / non-positive caps', () => {
    expect(truncateText('', 5)).toBe('')
    expect(truncateText(null, 5)).toBe('')
    expect(truncateText('abc', 0)).toBe('')
  })
})

describe('CO fields and shared cleaner', () => {
  it('a title cut inside an emoji is still well formed', () => {
    const r = parseCoFields({ title: 'a'.repeat(MAX_CO_TITLE_LENGTH - 1) + '😀more' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(isWellFormed(r.fields.title!)).toBe(true)
  })
  it('a scope note cut inside an emoji is still well formed', () => {
    const r = parseCoFields({ scopeImpactNote: 'b'.repeat(MAX_CO_SCOPE_NOTE_LENGTH - 1) + '😀more' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(isWellFormed(r.fields.scopeImpactNote!)).toBe(true)
  })
  it('cleanTextField (close/withdraw/escalate/exception reasons) is well formed at the cap', () => {
    const out = cleanTextField('c'.repeat(999) + '😀more', 1000)
    expect(out).not.toBeNull()
    expect(isWellFormed(out!)).toBe(true)
  })
})
