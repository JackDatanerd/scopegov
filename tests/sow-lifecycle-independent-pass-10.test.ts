import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTableAmount as p } from '@/lib/sow/table-schema'
import { amountsStated, validateSowForSend } from '@/lib/sow/validate-send'
import { sowRetainerTerms, sowRetainerTotal } from '@/lib/sow/retainer'
import { figuresPreserved } from '@/lib/sow/figures'

// SOW lifecycle, independent pass 10.
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

describe('B2 — spaces only group thousands, never fuse a label number with an amount', () => {
  it('reads real space/NBSP/apostrophe grouped amounts', () => {
    expect(p('1 500')).toBe(1500)
    expect(p('12 345 678,90')).toBe(12345678.9)
    expect(p('1\u00a0500,00')).toBe(1500)
    expect(p("1'500")).toBe(1500)
  })
  it('reports a cell with a second stray number as unreadable', () => {
    expect(p('Phase 1 5000')).toBeNull()
    expect(p('Q1 2026')).toBeNull()
    expect(p('10 - 15')).toBeNull()
    expect(p('100\n200')).toBeNull()
  })
  it('a schedule that only foots because of a fused label is no longer accepted', () => {
    const sections = [
      { id: 'parties', content: '<p>x</p>', visible: true }, { id: 'deliverables', table: [{ deliverable: 'A' }], visible: true },
      { id: 'oos', content: '<p>None</p>', visible: true }, { id: 'payment', content: '<p>USD 15,000</p>', visible: true },
      { id: 'payment_schedule', table: [{ milestone: 'Phase 1', amount: 'Phase 1 5000' }], visible: true },
      { id: 'governing_law', content: '<p>Kenya</p>', visible: true }, { id: 'signature', content: '<p>s</p>', visible: true },
    ]
    const v = validateSowForSend({ sections, metadata: { paymentStructure: 'milestones' }, contractValue: 15000 })
    expect(v.errors.join(' ')).toContain("Couldn't read the amount")
  })
})

describe('B3 — an ASCII hyphen is a minus only when it is a sign, not a separator', () => {
  it('still reads real negatives', () => {
    for (const [i, e] of [['-500', -500], ['- 500', -500], ['-$500', -500], ['$ -500', -500], ['USD -1,200.50', -1200.5], ['USD-500', -500], ['Credit: -$500', -500], ['(500)', -500], ['500-', -500]] as const)
      expect(p(i)).toBe(e)
  })
  it('treats a separator hyphen as punctuation', () => {
    expect(p('Deposit - $500')).toBe(500)
    expect(p('Deposit - 500')).toBe(500)
    expect(p('Final-500')).toBe(500)
    expect(p('Fee - 1,500.00 USD')).toBe(1500)
    expect(p('Total - 12,500')).toBe(12500)
  })
})

describe('B4 — a percentage is not an amount', () => {
  it('is unreadable, so the editor and send check say so', () => {
    expect(p('50%')).toBeNull()
    expect(p('12.5 %')).toBeNull()
    expect(p('50 percent')).toBeNull()
  })
  it('two 50% rows no longer "foot" to a 100 contract', () => {
    const sections = [
      { id: 'parties', content: '<p>x</p>', visible: true }, { id: 'deliverables', table: [{ deliverable: 'A' }], visible: true },
      { id: 'oos', content: '<p>None</p>', visible: true }, { id: 'payment', content: '<p>USD 100</p>', visible: true },
      { id: 'payment_schedule', table: [{ milestone: 'A', amount: '50%' }, { milestone: 'B', amount: '50%' }], visible: true },
      { id: 'governing_law', content: '<p>Kenya</p>', visible: true }, { id: 'signature', content: '<p>s</p>', visible: true },
    ]
    const v = validateSowForSend({ sections, metadata: { paymentStructure: 'milestones' }, contractValue: 100 })
    expect(v.errors.join(' ')).toContain("Couldn't read the amount")
  })
})

describe('B5 — "net" only excludes a day count, not an amount', () => {
  it('counts "net 5,000" as stating 5000 but still skips "net 30"', () => {
    expect(amountsStated('Total fee net 5,000 USD')).toContain(5000)
    expect(amountsStated('Payment net 30')).toEqual([])
    expect(amountsStated('Payment terms net 100')).toEqual([])
  })
  it('does not raise the false "does not state the contract value" warning', () => {
    const v = validateSowForSend({ sections: [{ id: 'payment', content: '<p>Total fee net 5,000 USD</p>', visible: true }], metadata: {}, contractValue: 5000 })
    expect(v.warnings.join(' ')).not.toContain('does not state the contract value')
  })
})

describe('B1 — a retainer states its value as monthly everywhere', () => {
  it('derives retainer terms from the project', () => {
    expect(sowRetainerTerms({ type: 'retainer', retainer_duration_months: 24 })).toEqual({ isRetainer: true, months: 24 })
    expect(sowRetainerTerms({ type: 'retainer', retainer_duration_months: null })).toEqual({ isRetainer: true, months: null })
    expect(sowRetainerTerms({ type: 'fixed', retainer_duration_months: 12 })).toEqual({ isRetainer: false, months: null })
    expect(sowRetainerTerms(null)).toEqual({ isRetainer: false, months: null })
    expect(sowRetainerTotal(10000, { isRetainer: true, months: 24 })).toBe(240000)
    expect(sowRetainerTotal(10000, { isRetainer: true, months: null })).toBeNull()
  })
  it('every SOW surface selects and passes the retainer terms', () => {
    for (const f of ['app/api/pdf/sow/[id]/route.ts', 'app/api/portal/sow/[token]/pdf/route.ts', 'app/api/portal/sow/[token]/sign/route.ts', 'app/api/portal/sow/[token]/route.ts', 'lib/documents/send-sow.ts']) {
      const src = read(f)
      expect(src, f).toContain('retainer_duration_months')
      expect(src, f).toContain('sowRetainerTerms')
    }
    expect(read('lib/pdf/chrome-labels.ts')).toContain('Monthly retainer fee')
    expect(read('app/portal/sow/[token]/page.tsx')).toContain('Monthly retainer fee')
    expect(read('lib/email/templates.ts')).toContain('Monthly retainer fee')
    expect(read('app/(app)/sow/page.tsx')).toContain("'/mo'")
    expect(read('app/api/sow/generate/route.ts')).toContain('retainer:')
  })
})

describe('B6 — a single-section rewrite may not change figures', () => {
  it('accepts a rewrite with the same figures', () => {
    expect(figuresPreserved('<p>Total USD 12,500 with 2 rounds of revisions.</p>', '<p>The fee is USD 12,500 and includes 2 rounds of revisions.</p>', null)).toBe(true)
  })
  it('rejects a changed or dropped amount / round count', () => {
    expect(figuresPreserved('<p>Total USD 12,500 with 2 rounds.</p>', '<p>Total USD 15,000 with 2 rounds.</p>', null)).toBe(false)
    expect(figuresPreserved('<p>Total USD 12,500 with 2 rounds.</p>', '<p>Total USD 12,500 with two rounds.</p>', null)).toBe(false)
    expect(figuresPreserved('<p>Pay USD 12,500.</p>', '<p>Pay USD 12,500 and USD 500 late fee.</p>', null)).toBe(false)
  })
  it('allows figure changes when the person typed a number into their instruction', () => {
    expect(figuresPreserved('<p>2 rounds</p>', '<p>3 rounds</p>', 'make it 3 rounds')).toBe(true)
  })
  it('the route enforces it and the prompt says so', () => {
    const src = read('app/api/sow/regenerate-section/route.ts')
    expect(src).toContain('figuresPreserved(')
    expect(src).toContain('Keep EVERY amount')
  })
})
