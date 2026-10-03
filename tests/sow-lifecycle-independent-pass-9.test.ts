import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizePlainText, cleanTextField } from '@/lib/utils/sanitize'
import { mapPdfSymbols } from '@/lib/pdf/pdf-symbols'
import { sanitizeForPdf } from '@/lib/pdf/fonts'
import { sanitizeTableRows } from '@/lib/sow/sections'

// SOW lifecycle, independent pass 9.

describe('B1 — bracketed placeholder text is no longer deleted from plain-text fields', () => {
  it('keeps <client name>, <email>, <TBC> style placeholders', () => {
    expect(sanitizePlainText('Contact <client name> by Friday')).toBe('Contact <client name> by Friday')
    expect(sanitizePlainText('Send to <email>')).toBe('Send to <email>')
    expect(sanitizePlainText('Date: <TBC>')).toBe('Date: <TBC>')
    expect(cleanTextField('Fee <amount> per month', 100)).toBe('Fee <amount> per month')
  })
  it('still strips real markup, including attributes and closing tags', () => {
    expect(sanitizePlainText('<b>bold</b> text')).toBe('bold text')
    expect(sanitizePlainText('hi <script>alert(1)</script>there')).toBe('hi there')
    expect(sanitizePlainText('<img src=x onerror=alert(1)>ok')).toBe('ok')
    expect(sanitizePlainText('<a href="https://x.test">link</a>')).toBe('link')
    expect(sanitizePlainText('<p>Please look at this today</p>')).toBe('Please look at this today')
    expect(sanitizePlainText('<b></b><b></b>   ')).toBe('')
  })
  it('never preserves a bracketed run that could carry an attribute', () => {
    expect(sanitizePlainText('<foo onclick=alert(1)>x')).not.toContain('onclick')
    expect(sanitizePlainText('<foo bar="1">x')).not.toContain('bar')
  })
  it('leaves lone comparison signs alone, as before', () => {
    expect(sanitizePlainText('Load < 2s and > 90 score')).toBe('Load < 2s and > 90 score')
  })
  it('a deliverables cell keeps its placeholder through the SOW table sanitizer', () => {
    const rows: any[] = sanitizeTableRows('deliverables', [
      { deliverable: 'Report for <client name>', acceptanceCriteria: 'Signed off', owner: 'Provider', targetDate: '' },
    ])
    expect(rows[0].deliverable).toBe('Report for <client name>')
  })
})

describe('B2 — only image data URIs are exempt from PDF text cleanup', () => {
  it('maps symbols in text that merely starts with "data:"', () => {
    expect(mapPdfSymbols('data: migration \u2713 done')).toBe('data: migration Yes done')
  })
  it('replaces unsupported glyphs in text that starts with "data:"', () => {
    expect(sanitizeForPdf('data: ok \u{1F600}')).not.toContain('\u{1F600}')
  })
  it('leaves real image data URIs byte-for-byte alone', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo\u2713='
    expect(mapPdfSymbols(png)).toBe(png)
    expect(sanitizeForPdf(png)).toBe(png)
  })
})

describe('B3 — the SOW send claim also checks the version that was validated', () => {
  const src = readFileSync(join(process.cwd(), 'lib/documents/send-sow.ts'), 'utf8')
  it('reads updated_at with the SOW and compares it in the claim', () => {
    expect(src).toMatch(/select\(`id, version, status, project_id, document_number, sections, metadata, updated_at,/)
    expect(src).toMatch(/\.eq\('status', 'draft'\)[\s\S]{0,400}\.eq\('updated_at', sow\.updated_at\)/)
  })
  it('tells a lost claim on a still-draft SOW apart from "already sent"', () => {
    expect(src).toContain('This SOW was edited while it was being sent')
    expect(src).toContain('This SOW was already sent by another action')
  })
})
