import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { computeCoTotals } from '@/lib/documents/co-totals'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

describe('CO-B1: blank line items are not stored', () => {
  it('drops a row with no description and no value, keeps real rows', () => {
    const r = computeCoTotals([
      { description: 'Extra pages', quantity: 3, rate: 100 },
      { description: '', quantity: 1, rate: 0 },
      { description: '   ', quantity: 5, rate: 0 },
    ], 0, false)
    if (!r.ok) throw new Error(r.error)
    expect(r.totals.lineItems).toHaveLength(1)
    expect(r.totals.total).toBe(300)
  })
  it('keeps a described zero-rate line (the AI draft shape) and a priced line missing its description', () => {
    const r = computeCoTotals([
      { description: 'Discovery', quantity: 2, rate: 0 },
      { description: '', quantity: 1, rate: 50 },
    ], 0, false)
    if (!r.ok) throw new Error(r.error)
    expect(r.totals.lineItems).toHaveLength(2) // the unnamed priced line stays so send validation can reject it
  })
  it('still reports a malformed blank row', () => {
    expect(computeCoTotals([{ description: '', quantity: 'abc', rate: 0 }], 0, false).ok).toBe(false)
  })
  it('works for credits and never drops an allowlisted adjustment line', () => {
    const c = computeCoTotals([{ description: 'Removed SEO', quantity: 1, rate: 200 }, { description: '', quantity: 1, rate: 0 }], 0, false, undefined, { credit: true })
    if (!c.ok) throw new Error(c.error)
    expect(c.totals.lineItems).toHaveLength(1)
    expect(c.totals.total).toBe(-200)
    const a = computeCoTotals([
      { description: 'Build', quantity: 1, rate: 5000 },
      { id: 'adj', description: 'Negotiated discount (per counter-offer)', quantity: 1, rate: -1000, kind: 'adjustment' },
    ], 0, false, ['adj'])
    if (!a.ok) throw new Error(a.error)
    expect(a.totals.lineItems).toHaveLength(2)
  })
})

describe('CO-B2: revise removes the orphan draft when the supersede loses its race', () => {
  const src = read('app/api/co/[id]/revise/route.ts')
  const lostRace = src.slice(src.indexOf('supersede lost a race'))
  it('deletes the new draft and its attachment rows and returns 409', () => {
    expect(lostRace).toMatch(/from\('co_attachments'\)\.delete\(\)\.eq\('co_id', revision\.id\)/)
    expect(lostRace).toMatch(/from\('change_orders'\)\.delete\(\)\.eq\('id', revision\.id\)\.eq\('status', 'draft'\)/)
    expect(lostRace).toMatch(/status: 409/)
  })
})

describe('CO-B3: exception only on the newest version, and logs only a real flag resolution', () => {
  const src = read('app/api/co/[id]/exception/route.ts')
  it('selects version/root_co_id and refuses when a newer sibling exists', () => {
    expect(src).toMatch(/total,version,root_co_id,/)
    expect(src).toMatch(/Number\(o\.version\) > Number\(\(co as any\)\.version\)/)
    expect(src.indexOf('newer version')).toBeLessThan(src.indexOf("from('exceptions_log').insert"))
  })
  it('only audits flag.exception_granted when the update matched a row', () => {
    expect(src).toMatch(/const \{ resolved \} = await resolveFlagAsException\(/)
    expect(src).toMatch(/if \(resolved\) \{\s+await logAudit\([\s\S]{0,300}flag\.exception_granted/)
  })
})

describe('accept-co-counter parses stored line items safely', () => {
  it('uses parseStoredLineItems rather than a raw JSON.parse', () => {
    const src = read('lib/documents/accept-co-counter.ts')
    expect(src).toMatch(/parseStoredLineItems\(co\.line_items\)/)
    expect(src).not.toMatch(/JSON\.parse\(co\.line_items\)/)
  })
})
