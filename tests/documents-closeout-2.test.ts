import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { coNetImpact } from '@/lib/documents/co-contract-value'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('project header "At risk" is net of tax like the values beside it', () => {
  it('sums each pending CO\'s net subtotal, not its tax-inclusive total', () => {
    expect(coNetImpact({ subtotal: 700, total: 757.75 })).toBe(700)
    const src = read('components/projects/ProjectDetail.tsx')
    expect(src).toContain('openCos.reduce((s: number, co: any) => s + coNetImpact(co), 0)')
    expect(src).not.toContain('s + (co.total || 0), 0)')
  })
})

describe('change order drafts', () => {
  const draft = read('app/api/co/draft/route.ts')
  it('knows who the Client is, so work about people reads correctly for a business', () => {
    expect(draft).toContain('clients(name, company_name)')
    expect(draft).toContain('${clientContextLine}')
    expect(draft).toContain('one individual nominated by the Client')
  })
  it('never writes "lasting up to N sessions" and states client dependencies', () => {
    expect(draft).toContain('Never write \\"lasting up to N session(s)\\"')
    expect(draft).toContain('the Client schedules it with the Provider')
  })
  it('the prompt template still closes after the last rule', () => {
    expect(draft).toMatch(/Do not invent a date\.`\s*\n/)
  })
})

describe('invoice contract position labels are distinct from the totals block', () => {
  const r = read('lib/pdf/renderer.tsx')
  it('uses "on the contract" wording so it never reads as a second "Paid to date"', () => {
    expect(r).toContain('Paid on the contract to date')
    expect(r).toContain('Invoiced on the contract to date')
  })
})

describe('SOW prompt defines the basis of revision rounds once', () => {
  it('shared by default, round defined to match', () => {
    const s = read('lib/ai/sow-content.ts')
    expect(s).toContain('SHARED across all the deliverables together')
    expect(s).toContain('Never mix the two')
  })
})
