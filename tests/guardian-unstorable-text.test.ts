import { describe, it, expect } from 'vitest'
import { stripUnstorableText, truncateText } from '@/lib/utils/sanitize'
import { toPlainText, embeddingText, MAX_CHECK_CONTENT_CHARS } from '@/lib/ai/guardian'
import { cleanSubject } from '@/lib/ai/guardian-email'

const hasBad = (s: string) => /[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('Guardian text is always storable in Postgres', () => {
  it('stripUnstorableText removes NUL and repairs lone surrogates but keeps valid pairs', () => {
    expect(stripUnstorableText('a\u0000b')).toBe('ab')
    expect(stripUnstorableText('x\uD83D')).toBe('x\uFFFD')
    expect(stripUnstorableText('\uDE00y')).toBe('\uFFFDy')
    expect(stripUnstorableText('ok 😀 fine')).toBe('ok 😀 fine')
    expect(stripUnstorableText(null)).toBe('')
  })

  it('toPlainText strips NUL from plain and HTML bodies', () => {
    expect(toPlainText('hello\u0000world')).toBe('helloworld')
    expect(toPlainText('<p>a\u0000b</p>')).toBe('ab')
  })

  it('an inbound-style cap landing mid-emoji does not leave half an emoji', () => {
    const body = 'a'.repeat(MAX_CHECK_CONTENT_CHARS - 1) + '😀tail'
    const capped = truncateText(toPlainText(body), MAX_CHECK_CONTENT_CHARS)
    expect(hasBad(capped)).toBe(false)
    expect(capped.length).toBeLessThanOrEqual(MAX_CHECK_CONTENT_CHARS)
  })

  it('embeddingText never returns a split pair, whichever side is cut', () => {
    const long = 'é'.repeat(998) + '😀' + 'z'.repeat(1500) + '😀' + 'é'.repeat(997)
    expect(hasBad(embeddingText(long))).toBe(false)
    expect(hasBad(embeddingText('é'.repeat(999) + '😀' + 'z'.repeat(2000)))).toBe(false)
  })

  it('cleanSubject caps at 300 without splitting an emoji and strips NUL', () => {
    const s = cleanSubject('Re: ' + 'a'.repeat(299) + '😀x')
    expect(hasBad(s)).toBe(false)
    expect(s.length).toBeLessThanOrEqual(300)
    expect(cleanSubject('Fwd: a\u0000b')).toBe('ab')
  })
})

describe('estimated value pattern accepts .5', () => {
  const re = /^\s*(\d+(\.\d*)?|\.\d+)\s*$/
  it('accepts plain, leading-dot and trailing-dot decimals; rejects junk', () => {
    for (const ok of ['5', '0.5', '.5', '5.', ' 12.50 ']) expect(re.test(ok)).toBe(true)
    for (const bad of ['.', '', 'abc', '1e3', '-1', '1.2.3']) expect(re.test(bad)).toBe(false)
  })
})
