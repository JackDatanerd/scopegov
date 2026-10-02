import React from 'react'
import { describe, it, expect } from 'vitest'
import { RichText, escapeStrayAngleBrackets } from '@/lib/pdf/rich-text'
import { mapPdfSymbols } from '@/lib/pdf/pdf-symbols'
import { truncateText } from '@/lib/utils/sanitize'
import { sanitizeSectionList, sanitizeTableRows, MAX_TABLE_ROWS, MAX_TABLE_CELL_LENGTH } from '@/lib/sow/sections'

// Walk the element tree RichText returns, expanding function components, and collect text and link targets.
function walk(node: any, out: { text: string; links: string[] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { out.text += String(node); return }
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return }
  if (node.type === React.Fragment) { walk(node.props.children, out); return }
  if (typeof node.type === 'function') { walk(node.type(node.props), out); return }
  if (node.props?.src && typeof node.props.src === 'string') out.links.push(node.props.src)
  walk(node.props?.children, out)
}
function render(html: string) {
  const out = { text: '', links: [] as string[] }
  walk(RichText({ html, style: {} }), out)
  return out
}
// The renderer maps symbols over the whole payload (HTML included) before RichText sees it.
const viaRenderer = (html: string) => render(mapPdfSymbols(html))

describe('SOW PDF rich text: symbol mapping must not corrupt markup', () => {
  it('keeps text around ≤ ≥ ← ↔ instead of dropping or swallowing it', () => {
    const out = viaRenderer('<p>Response time ≤ 48 hours and uptime ≥ 99%. Step A ← Step B ↔ Step C.</p>')
    expect(out.text).toBe('Response time <= 48 hours and uptime >= 99%. Step A <- Step B <-> Step C.')
  })
  it('keeps bold text that follows a mapped symbol', () => {
    expect(viaRenderer('<p>Fee ≤ <strong>5000</strong> total</p>').text).toBe('Fee <= 5000 total')
  })
  it('handles mapped symbols inside list items and loose text', () => {
    expect(viaRenderer('<ul><li><p>Load ≤ 2s</p></li><li><p>Errors ≤ 1%</p></li></ul>').text).toContain('Load <= 2s')
    expect(viaRenderer('<ul><li><p>Load ≤ 2s</p></li><li><p>Errors ≤ 1%</p></li></ul>').text).toContain('Errors <= 1%')
    expect(viaRenderer('Loose ≤ text ≥ here').text).toBe('Loose <= text >= here')
  })
  it('still treats real tags as tags', () => {
    expect(escapeStrayAngleBrackets('<p>a <= b</p><br><a href="x">y</a>')).toBe('<p>a &lt;= b</p><br><a href="x">y</a>')
    expect(render('<p>Hello <em>there</em></p>').text).toBe('Hello there')
  })
})

describe('SOW PDF rich text: link targets', () => {
  it('decodes entities in the href so query parameters survive', () => {
    const out = render('<p><a href="https://x.com/?a=1&amp;b=2&amp;c=%20" rel="noopener noreferrer" target="_blank">brief</a></p>')
    expect(out.links).toEqual(['https://x.com/?a=1&b=2&c=%20'])
    expect(out.text).toBe('brief')
  })
  it('does not double-decode', () => {
    expect(render('<p><a href="https://x.com/?q=&amp;amp;">l</a></p>').links).toEqual(['https://x.com/?q=&amp;'])
  })
})

describe('SOW text caps never strand half an emoji', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
  it('truncateText backs off a split pair (the milestone title/trigger caps)', () => {
    const title = 'a'.repeat(199) + '😀tail'
    expect(lone.test(truncateText(title, 200))).toBe(false)
    const trigger = 'b'.repeat(499) + '😀tail'
    expect(lone.test(truncateText(trigger, 500))).toBe(false)
  })
  it('whole-list sanitizer cuts section content on a code point boundary', () => {
    const content = '<p>' + 'x'.repeat(49_996) + '😀😀</p>'
    const [sec] = sanitizeSectionList([{ id: 'parties', content }], []) as any[]
    expect(lone.test(sec.content)).toBe(false)
  })
})

describe('generated tables obey the same caps as saved ones', () => {
  it('caps rows and cell length and strips markup', () => {
    const rows = Array.from({ length: MAX_TABLE_ROWS + 20 }, (_, i) => ({
      phase: `P${i}`, description: 'd'.repeat(MAX_TABLE_CELL_LENGTH + 500), duration: '<b>2w</b>',
    }))
    const out = sanitizeTableRows('timeline', rows)
    expect(out).toHaveLength(MAX_TABLE_ROWS)
    expect(out[0].description.length).toBeLessThanOrEqual(MAX_TABLE_CELL_LENGTH)
    expect(out[0].duration).toBe('2w')
  })
})
