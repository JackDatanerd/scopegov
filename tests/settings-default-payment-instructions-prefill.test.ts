import { describe, it, expect } from 'vitest'
import { plainTextToRichHtml } from '@/lib/utils/plain-to-rich'
import { parsePaymentInstructions } from '@/lib/documents/invoice-totals'

describe('plainTextToRichHtml (Settings default → invoice editor prefill)', () => {
  it('keeps line breaks as <br> inside one paragraph', () => {
    expect(plainTextToRichHtml('Bank: KCB\nAccount: 123\nSwift: KCBLKENX'))
      .toBe('<p>Bank: KCB<br>Account: 123<br>Swift: KCBLKENX</p>')
  })
  it('splits blank-line separated blocks into paragraphs and handles CRLF', () => {
    expect(plainTextToRichHtml('A\r\nB\r\n\r\nC')).toBe('<p>A<br>B</p><p>C</p>')
  })
  it('escapes markup typed into the plain-text setting', () => {
    expect(plainTextToRichHtml('Pay <b>now</b> & "soon"')).toBe('<p>Pay &lt;b&gt;now&lt;/b&gt; &amp; &quot;soon&quot;</p>')
  })
  it('returns empty for blank / non-string input', () => {
    expect(plainTextToRichHtml('  \n ')).toBe('')
    expect(plainTextToRichHtml(null)).toBe('')
    expect(plainTextToRichHtml(undefined)).toBe('')
  })
  it('survives the invoice save sanitizer with breaks intact', () => {
    const r = parsePaymentInstructions(plainTextToRichHtml('Bank: KCB\nAccount: 123'))
    expect(r).toEqual({ ok: true, value: expect.stringContaining('Bank: KCB<br') })
    if (r.ok) expect(r.value).toContain('Account: 123')
  })
})
