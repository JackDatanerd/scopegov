import { describe, it, expect } from 'vitest'
import { rankBy, scoreMatch, foldedTokens, foldedPhrase } from '@/lib/search/query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Round 11: the exact-match bonus must look at the row's own identifying fields, not the joined ranking text.
const run = <T,>(q: string, rows: T[], text: (r: T) => string, prim?: (r: T) => (string | null | undefined)[]) =>
  rankBy(rows, foldedTokens(q), text, foldedPhrase(q), prim)

describe('exact-name ranking (round 11)', () => {
  it('a project named exactly the query outranks six newer prefix siblings', () => {
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map(i => ({ name: `Website Redesign ${i}`, disc: null, internal_ref: null, clients: { name: 'Acme' } })),
      { name: 'Website', disc: null, internal_ref: null, clients: { name: 'Acme' } },
    ]
    const text = (p: any) => `${p.name} ${p.disc || ''} ${p.internal_ref || ''} ${p.clients?.name || ''}`
    const top5 = run('website', rows, text, p => [p.name, p.internal_ref]).slice(0, 5)
    expect(top5[0].name).toBe('Website')
  })

  it('a client named exactly the query wins even when it has a company name', () => {
    const rows: any[] = [1, 2, 3, 4, 5].map(i => ({ name: `Acme Labs ${i}`, company_name: 'Acme Inc' }))
    rows.push({ name: 'Acme', company_name: 'Acme Holdings' })
    expect(run('acme', rows, c => `${c.name} ${c.company_name || ''}`, c => [c.name])[0].name).toBe('Acme')
  })

  it('an exact document number beats longer numbers it prefixes', () => {
    const rows: any[] = ['INV-00019', 'INV-00018', 'INV-00017', 'INV-00016', 'INV-00010', 'INV-0001']
      .map(n => ({ invoice_number: n, title: 'Work', projects: { name: 'Acme' } }))
    const r = run('inv-0001', rows, i => `${i.invoice_number} ${i.title} ${i.projects.name}`, i => [i.title, i.invoice_number])
    expect(r[0].invoice_number).toBe('INV-0001')
  })

  it('a change order titled exactly the query beats one whose number sorts first', () => {
    const rows: any[] = [
      { document_number: 'CO-002', title: 'Extra pages and more', projects: { name: 'P' } },
      { document_number: 'CO-001', title: 'Extra pages', projects: { name: 'P' } },
    ]
    const r = run('extra pages', rows, c => `${c.document_number} ${c.title} ${c.projects.name}`, c => [c.title, c.document_number])
    expect(r[0].title).toBe('Extra pages')
  })

  it('matches accent-insensitively and ignores null primaries', () => {
    expect(scoreMatch('Café Redesign X', ['cafe'], 'cafe', ['Café', null, undefined])).toBeGreaterThanOrEqual(100)
    expect(scoreMatch('Foo', ['foo'], 'foo', [null])).toBe(scoreMatch('Foo', ['foo'], 'foo'))
  })

  it('is unchanged when no primaries are given', () => {
    expect(scoreMatch('Acme Labs', ['acme'], 'acme')).toBe(scoreMatch('Acme Labs', ['acme'], 'acme', undefined))
  })

  it('every rankBy call in the route passes primaries except the name-only members block', () => {
    const src = readFileSync(join(__dirname, '../app/api/search/route.ts'), 'utf8')
    const calls = src.split('rankBy(').slice(1).map(c => c.split('\n')[0])
    expect(calls.length).toBe(8)
    const without = calls.filter(c => !/wholeFolded, \w+ => \[/.test(c))
    expect(without.length).toBe(1)
    expect(without[0]).toContain('m.users?.name')
  })
})
