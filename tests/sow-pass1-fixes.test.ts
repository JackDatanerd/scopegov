import { describe, it, expect } from 'vitest'
import React from 'react'
import { RichText } from '@/lib/pdf/rich-text'
import { sanitizeRichText } from '@/lib/utils/sanitize'

// Expands function components and returns all text, with '|' marking each <View>.
function flat(n: any): string {
  if (n == null || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join('')
  if (typeof n.type === 'function') return flat(n.type(n.props))
  const kids = n.props?.children
  return (n.type === 'View' || n.props?.style?.borderLeft ? '|' : '') + flat(kids)
}
const render = (html: string) => flat(RichText({ html: sanitizeRichText(html), style: {} }))

describe('SOW PDF rich text — Tiptap-shaped HTML (B1)', () => {
  it('list items wrapped in <p> print their text, never the tag remnants', () => {
    const out = render('<ul><li><p>Homepage design</p></li><li><p>Blog <strong>setup</strong></p></li></ul>')
    expect(out).toContain('Homepage design')
    expect(out).toContain('Blog setup')
    expect(out).not.toMatch(/p>|<|\/p/)
  })
  it('ordered + nested lists with <p> items', () => {
    const out = render('<ol><li><p>Step A</p><ul><li><p>sub item</p></li></ul></li></ol>')
    expect(out).toContain('1.')
    expect(out).toContain('Step A')
    expect(out).toContain('sub item')
    expect(out).not.toMatch(/p>/)
  })
  it('multi-paragraph list item keeps both paragraphs', () => {
    const out = render('<ul><li><p>First para</p><p>Second para</p></li></ul>')
    expect(out).toContain('First para')
    expect(out).toContain('Second para')
    expect(out).not.toMatch(/p>/)
  })
  it('blockquote with <p> children renders its text cleanly', () => {
    const out = render('<blockquote><p>Client supplies all copy.</p></blockquote>')
    expect(out).toContain('Client supplies all copy.')
    expect(out).not.toMatch(/p>/)
  })
  it('legacy bare-<li> and bare-blockquote content still renders', () => {
    expect(render('<ul><li>Legacy item</li></ul>')).toContain('Legacy item')
    expect(render('<blockquote>Legacy quote</blockquote>')).toContain('Legacy quote')
  })
  it('empty paragraphs from a cleared editor draw nothing', () => {
    expect(render('<p>a</p><p></p><p>b</p>')).toBe('ab')
    expect(render('<p></p>')).toBe('')
  })
  it('unknown tags never leak as text', () => {
    expect(render('<p>Hello <span>there</span></p>')).not.toMatch(/span/)
  })
  it('plain paragraphs and formatting are unchanged', () => {
    expect(render('<p>Hello <strong>world</strong></p>')).toBe('Hello world')
  })
})

import fs from 'fs'
import path from 'path'
import { resolveAttachmentType, matchesDeclaredType, ALLOWED_ATTACHMENT_TYPES } from '@/lib/utils/file-signature'
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

describe('attachment type resolution (B5)', () => {
  it('fills in .eml when the browser sends no type', () => {
    expect(resolveAttachmentType('client brief.eml', '')).toBe('message/rfc822')
    expect(resolveAttachmentType('BRIEF.EML', 'application/octet-stream')).toBe('message/rfc822')
    expect(ALLOWED_ATTACHMENT_TYPES.has(resolveAttachmentType('a.eml', ''))).toBe(true)
  })
  it('never overrides a declared, recognised type', () => {
    expect(resolveAttachmentType('a.eml', 'text/plain')).toBe('text/plain')
    expect(resolveAttachmentType('scan.pdf', 'image/png')).toBe('image/png')
  })
  it('unknown extensions stay rejected', () => {
    expect(ALLOWED_ATTACHMENT_TYPES.has(resolveAttachmentType('run.exe', ''))).toBe(false)
    expect(ALLOWED_ATTACHMENT_TYPES.has(resolveAttachmentType('noext', ''))).toBe(false)
  })
  it('magic bytes still guard an extension-resolved binary type', () => {
    expect(matchesDeclaredType(resolveAttachmentType('x.pdf', ''), Buffer.from('<html>'))).toBe(false)
    expect(matchesDeclaredType(resolveAttachmentType('x.pdf', ''), Buffer.from('%PDF-1.7'))).toBe(true)
  })
  it('all three attachment routes use the resolved type', () => {
    for (const p of ['app/api/sow/[id]/attachments/route.ts', 'app/api/co/[id]/attachments/route.ts',
      'app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts']) {
      const src = read(p)
      expect(src).toContain('resolveAttachmentType(file.name, file.type)')
      expect(src.match(/ALLOWED_TYPES\.has\(file\.type\)/)).toBeNull()
    }
  })
})

describe('reopen only clears its own stall (B2)', () => {
  const src = read('app/api/sow/[id]/reopen/route.ts')
  it('no unconditional Stalled reset', () => {
    expect(src).not.toMatch(/\.in\('status', \[[^\]]*'Stalled'[^\]]*\]\)/)
    expect(src).toMatch(/\.eq\('status', 'Stalled'\)\.eq\('stall_reason', 'sow_unsigned'\)/)
  })
})

describe('regenerate-section counts the empty-reply call (B3)', () => {
  it('records usage before the empty-content return', () => {
    const src = read('app/api/sow/regenerate-section/route.ts')
    const i = src.indexOf("'Regeneration produced empty content'")
    expect(src.slice(src.lastIndexOf('recordAiUsage', i) - 10, i)).toContain('recordAiUsage')
  })
})

describe('empty prose sections are omitted (B4) and solo banner (B6)', () => {
  it('PDF renderer and portal page filter blank non-table sections', () => {
    expect(read('lib/pdf/renderer.tsx')).toContain('isTableSection(sec.id) || hasRichText(sec.content)')
    const portal = read('app/portal/sow/[token]/page.tsx')
    expect(portal).toContain('isTableSection(s.id) || hasText(s.content)')
    // hasText must be declared before visibleSections uses it (TDZ)
    expect(portal.indexOf('const hasText')).toBeLessThan(portal.indexOf('const visibleSections'))
  })
  it('solo banner only when rows are actually hidden', () => {
    expect(read('app/(app)/sow/page.tsx')).toContain('isSoloCapped && stats.total > safeSows.length')
  })
})
