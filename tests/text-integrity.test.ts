import { describe, it, expect } from 'vitest'
import { sanitizePlainText, decodeHtmlEntities, cleanTextField } from '@/lib/utils/sanitize'
import { mapPdfSymbols } from '@/lib/pdf/pdf-symbols'
import { computeContentHash } from '@/lib/documents/executed-pdf'
import { isValidSignatureImage } from '@/lib/utils/signature'
import { hydrateSections } from '@/lib/sow/sections'

describe('plain-text sanitising', () => {
  it('returns real text, not HTML-escaped entities', () => {
    expect(sanitizePlainText('Design & Build')).toBe('Design & Build')
    expect(sanitizePlainText('Load < 2s and > 90 score')).toBe('Load < 2s and > 90 score')
    expect(sanitizePlainText('<b>bold</b> text')).toBe('bold text')
    expect(sanitizePlainText('R&D')).toBe('R&D')
  })
  it('decodes ampersand LAST so a literal "&lt;" stays literal', () => {
    expect(decodeHtmlEntities('&amp;lt;div&amp;gt;')).toBe('&lt;div&gt;')
    expect(decodeHtmlEntities('Tom &amp; Jerry &#39;s')).toBe("Tom & Jerry 's")
  })
  it('cleanTextField distinguishes missing, wrong-typed and capped values', () => {
    expect(cleanTextField(undefined, 10)).toBe('')
    expect(cleanTextField(42, 10)).toBeNull()
    expect(cleanTextField({ a: 1 }, 10)).toBeNull()
    expect(cleanTextField('abcdefghijklmnop', 10)).toBe('abcdefghij')
  })
})

describe('legacy table cells', () => {
  it('hydrateSections repairs cells stored as HTML entities and coerces a non-boolean visible flag', () => {
    const out = hydrateSections([
      { id: 'deliverables', visible: 'false', content: '', table: [{ deliverable: 'Design &amp; Build', acceptance: '&lt; 2s load' }] },
    ], { paymentStructure: 'lump_sum' })
    const d = out.find((s: any) => s.id === 'deliverables')
    expect(d.table[0].deliverable).toBe('Design & Build')
    expect(d.table[0].acceptance).toBe('< 2s load')
    expect(d.visible).toBe(true)
  })
})

describe('PDF symbol mapping', () => {
  it('replaces glyphs the embedded font cannot draw, deeply, and leaves data URLs alone', () => {
    const out = mapPdfSymbols({ a: '✓', list: ['x → y', { n: '≥ 3' }], img: 'data:image/png;base64,AAA✓' })
    expect(out.a).toBe('Yes')
    expect(out.list[0]).toBe('x -> y')
    expect((out.list[1] as any).n).toBe('>= 3')
    expect(out.img).toBe('data:image/png;base64,AAA✓')
  })
})

describe('executed-document fingerprint', () => {
  it('is stable across key order and changes when the content changes', () => {
    const a = computeContentHash({ x: 1, y: { b: 2, a: [1, 2] } })
    const b = computeContentHash({ y: { a: [1, 2], b: 2 }, x: 1 })
    expect(a).toBe(b)
    expect(a.length).toBe(64)
    expect(computeContentHash({ x: 2, y: { b: 2, a: [1, 2] } })).not.toBe(a)
  })
})

describe('signature image validation', () => {
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]).toString('base64')
  it('accepts real PNG/JPEG data and rejects everything else', () => {
    expect(isValidSignatureImage(png)).toBe(true)
    expect(isValidSignatureImage('data:image/png;base64,')).toBe(false)                     // truncated
    expect(isValidSignatureImage('data:image/svg+xml;base64,' + 'A'.repeat(200))).toBe(false) // SVG
    expect(isValidSignatureImage('data:image/png;base64,' + Buffer.alloc(200, 7).toString('base64'))).toBe(false) // not a PNG
    expect(isValidSignatureImage(42)).toBe(false)
  })
})
