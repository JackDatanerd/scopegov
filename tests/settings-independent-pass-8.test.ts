import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { parseStandardsInput } from '@/lib/utils/agency-standards'

describe('Settings independent pass 8', () => {
  it('standard terms drop NUL and repair unpaired surrogates instead of reaching Postgres', () => {
    const r = parseStandardsInput({
      revisionPolicy: 'two\u0000 rounds \ud83d',
      paymentTerms: 'net\u0000 14',
      outOfScopeClauses: ['host\u0000ing', '\u0000'],
      assumptions: ['a \ude00 b'],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const all = JSON.stringify(r.values)
    expect(all).not.toContain('\\u0000')
    expect(r.values.revision_policy).toBe('two rounds \ufffd')
    expect(r.values.payment_terms).toBe('net 14')
    expect(r.values.out_of_scope_clauses).toEqual(['hosting'])
    expect(r.values.assumptions).toEqual(['a \ufffd b'])
  })

  it('valid emoji and ampersands survive', () => {
    const r = parseStandardsInput({ revisionPolicy: 'Tom & Jerry 😀' })
    expect(r.ok && r.values.revision_policy).toBe('Tom & Jerry 😀')
  })

  it('defaults route strips governing law before storing', () => {
    const src = readFileSync('app/api/workspace/defaults/route.ts', 'utf8')
    expect(src).toContain('stripUnstorableText(governingLaw).trim()')
  })

  it('saved signature state is lifted out of BrandingTab', () => {
    const src = readFileSync('components/settings/SettingsClient.tsx', 'utf8')
    expect(src).not.toContain('useState<string | null>(savedSignature)')
    expect(src).toMatch(/const \[sigSaved, setSigSaved\] = useState<string \| null>\(workspace\?\.agency_signature_data/)
  })
})
