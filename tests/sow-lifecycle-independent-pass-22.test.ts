import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pdfBreakPoints, PDF_MAX_UNBROKEN } from '@/lib/pdf/fonts'
import { renderSowPdf } from '@/lib/pdf/renderer'
import { applyAgencyStandards, buildFallbackSections, buildFallbackTables } from '@/lib/ai/sow-content'

// SOW lifecycle, independent pass 22.

describe('B1 — a token wider than its box can wrap instead of running off the page', () => {
  it('leaves ordinary words whole (no mid-word hyphenation)', () => {
    for (const w of ['contract', 'Qualitätssicherungsmaßnahmen'.slice(0, 24), 'mkataba', 'a'.repeat(PDF_MAX_UNBROKEN)]) {
      expect(pdfBreakPoints(w)).toEqual([w])
    }
  })
  it('cuts a long unbroken token into pieces that rejoin to the original', () => {
    const url = 'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Acme-Website-Redesign?node-id=1234-5678&t=AbCdEfGhIjKlMnOp-0'
    const parts = pdfBreakPoints(url)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(url)
    expect(Math.max(...parts.map(p => p.length))).toBeLessThanOrEqual(16)
  })
  it('never splits a surrogate pair', () => {
    const w = '😀'.repeat(40)
    const parts = pdfBreakPoints(w)
    expect(parts.join('')).toBe(w)
    for (const p of parts) expect(Array.from(p).every(ch => ch === '😀')).toBe(true)
  })

  const pdftotext = spawnSync('pdftotext', ['-v'])
  const have = !pdftotext.error
  ;(have ? it : it.skip)('a long URL and a long run are fully present in the rendered PDF text', async () => {
    const url = 'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Acme-Website-Redesign?node-id=1234-5678&t=AbCdEfGhIjKlMnOp-0'
    const sections = [
      { id: 'overview', title: 'Overview', content: `<p>See ${url} now.</p><p>${'Z'.repeat(180)}</p>`, visible: true, order: 2 },
    ]
    const buf = await renderSowPdf({ agencyName: 'A', agencyLogoUrl: null, brandColour: '#1A5C3A', clientName: 'C', projectName: 'P', contractValue: 1000, currency: 'USD', version: 1, sections } as any)
    const dir = mkdtempSync(join(tmpdir(), 'sow22-'))
    const f = join(dir, 'a.pdf'); writeFileSync(f, buf)
    spawnSync('pdftotext', [f, join(dir, 'a.txt')])
    // Wrapped lines gain a hyphen at each break and a line break, so compare with those removed.
    const text = readFileSync(join(dir, 'a.txt'), 'utf8').replace(/[-\s]/g, '')
    expect(text).toContain(url.replace(/[-\s]/g, ''))
    expect((text.match(/Z/g) || []).length).toBe(180)
  }, 60000)
})

describe('B2 — the signing clause and the signature block are one unsplittable group', () => {
  it('renders with a clause and does not throw or warn about unsplittable content', async () => {
    const errs: string[] = []
    const orig = console.error, origW = console.warn
    console.error = (...a: any[]) => { errs.push(a.join(' ')) }; console.warn = console.error
    try {
      const filler = Array.from({ length: 34 }, (_, i) => `<p>Paragraph ${i} of agreed scope text that fills the page.</p>`).join('')
      const sections = [
        { id: 'overview', title: 'Overview', content: filler, visible: true, order: 2 },
        { id: 'signature', title: 'Signatures', content: '<p>By signing below, both parties agree to this Statement of Work.</p>', visible: true, order: 9 },
      ]
      const buf = await renderSowPdf({ agencyName: 'A', agencyLogoUrl: null, brandColour: '#1A5C3A', clientName: 'C', projectName: 'P', contractValue: 1000, currency: 'USD', version: 1, sections } as any)
      expect(buf.length).toBeGreaterThan(1000)
    } finally { console.error = orig; console.warn = origW }
    expect(errs.join('\n')).not.toMatch(/bigger than available page height/)
  }, 60000)
  it('the renderer groups the clause with the signature block', () => {
    const src = readFileSync(join(process.cwd(), 'lib/pdf/renderer.tsx'), 'utf8')
    expect(src).toContain('<View wrap={sigClauseSection && !fitsOnOnePage(sigClauseSection.content) ? undefined : false}>')
  })
})

describe('B3 — the standard revision wording must not contradict the project round count', () => {
  const run = (rp: string, rounds = 2) => applyAgencyStandards(
    { revisions: `<p>This engagement includes ${rounds} rounds of revisions per deliverable.</p>` },
    { outOfScopeClauses: [], assumptions: [], revisionPolicy: rp, paymentTerms: '' } as any, rounds,
  ).revisions
  const skipped = (rp: string, rounds?: number) => !run(rp, rounds).includes(rp)

  it.each([
    'Up to 3 rounds of revisions are included.',
    'We include 3 revision rounds per deliverable.',
    'Three rounds of revisions are included.',
    'Includes 3 review rounds.',
    'Up to three (3) rounds of feedback.',
    '3 rondas de revisión incluidas.',
    'Incluye tres rondas de revisión.',
    'Inclut 3 tours de révision.',
    '3 Überarbeitungsrunden sind enthalten.',
    'Drei Runden sind enthalten.',
  ])('conflicting standard is skipped: %s', rp => { expect(skipped(rp)).toBe(true) })

  it.each([
    'Up to 2 rounds of revisions are included.',
    'We include two revision rounds per deliverable.',
    'Includes 2 review rounds.',
    'Revisions must be requested within 5 business days.',
    'One additional round beyond these may be billed separately.',
    'Feedback is due within 5 days of each round.',
  ])('non-conflicting standard is still appended: %s', rp => { expect(skipped(rp)).toBe(false) })
})

describe('B4 — fallback tables never come out empty because of a bare bullet marker', () => {
  const base: any = { agencyName: 'A', clientName: 'C', projectName: 'P', projectType: 'web', language: 'en', contractValue: 1000, currency: 'USD', paymentLabel: 'x', revisionRounds: 2 }
  it.each(['-', '*', '  -  ', '-\n*\n-', '\u200b'])('brief %j yields the default row', raw => {
    const t = buildFallbackTables({ ...base, deliverables: raw, timeline: raw })
    expect(t.deliverables.length).toBe(1)
    expect(t.timeline.length).toBe(1)
    expect(t.deliverables[0].deliverable).toBeTruthy()
  })
  it('real lines still win and bullets are stripped', () => {
    const t = buildFallbackTables({ ...base, deliverables: '- Logo\n* Site\n-\n', timeline: 'Week 1' })
    expect(t.deliverables.map(r => r.deliverable)).toEqual(['Logo', 'Site'])
  })
})

describe('B5 — the fallback payment sentence formats the amount like the AI path', () => {
  const base: any = { agencyName: 'A', clientName: 'C', projectName: 'P', projectType: 'web', language: 'en', currency: 'USD', paymentLabel: 'Lump sum', revisionRounds: 2 }
  it('lump sum', () => {
    expect(buildFallbackSections({ ...base, contractValue: 12500.5 }).payment).toContain('USD 12,500.50')
    expect(buildFallbackSections({ ...base, contractValue: 12500 }).payment).toContain('USD 12,500.00')
  })
  it('retainer fee and total commitment', () => {
    const html = buildFallbackSections({ ...base, contractValue: 1500, retainer: { months: 12 } }).payment
    expect(html).toContain('USD 1,500.00')
    expect(html).toContain('USD 18,000.00')
  })
})
