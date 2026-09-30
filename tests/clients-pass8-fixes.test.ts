import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

describe('clients pass 8', () => {
  it('B1: client money figures keep their cents (invoice-derived ones use formatCurrencyExact)', () => {
    const src = read('app/(app)/clients/[id]/page.tsx')
    expect(src).toContain("formatCurrencyExact")
    expect(src).toContain("label === 'Contracted' ? formatCurrency(value, currency) : formatCurrencyExact(value, currency)")
  })
  it('B2: an all-archived roster is not described as "No clients yet"', () => {
    const src = read('components/clients/ClientsClient.tsx')
    expect(src).toContain("archivedCount > 0 ? 'All clients are archived' : 'No clients yet'")
    expect(src).toContain('!search && archivedCount === 0 &&')
  })
  it('B3: contact activity name strips the trailing balanced group, not the first ")"', () => {
    const src = read('app/(app)/clients/[id]/page.tsx')
    expect(src).toContain('contactNameFromEntity(String(a.entity_name), client.name)')
    expect(src).not.toContain("replace(/ \\([^)]*\\)$/, '')")
  })
  it('B4: timezone is behind the VIEW_CLIENT_DATA write gate', () => {
    const src = read('app/api/clients/[id]/route.ts')
    expect(src).toMatch(/const contactFields = \[[^\]]*'timezone'[^\]]*\]/)
  })
})
