import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTableAmount } from '@/lib/sow/table-schema'
import { amountsStated, amountsMentioned } from '@/lib/sow/validate-send'
import { figuresPreserved } from '@/lib/sow/figures'

describe('SOW lifecycle pass 21', () => {
  it('B4: trailing full stop after a decimal amount is readable', () => {
    expect(parseTableAmount('Ksh 1,000.00.')).toBe(1000)
    expect(parseTableAmount('USD 2,500.50.')).toBe(2500.5)
    expect(parseTableAmount('1,500.')).toBe(1500)
    expect(parseTableAmount('$1,500.00')).toBe(1500)
    expect(parseTableAmount('Phase 2: 5,000')).toBeNull()
  })
  it('B5: k / M / million shorthand in prose', () => {
    expect(amountsStated('Total fee USD 1.5M payable')).toEqual([1500000])
    expect(amountsStated('Fee 50k upfront')).toEqual([50000])
    expect(amountsMentioned('about 2 million')).toEqual([2000000])
    expect(amountsStated('over 12 months')).toEqual([])
    expect(figuresPreserved('<p>USD 1.5M</p>', '<p>USD 2M</p>')).toBe(false)
  })
  it('B6: dates are not amounts', () => {
    expect(amountsStated('Due 2026-10-15, total USD 3,000')).toEqual([3000])
    expect(amountsStated('Due 15/10/2026 total USD 3,000')).toEqual([3000])
  })
  it('B3 + B2: generate validates projectId and re-checks live SOWs after the model call', () => {
    const src = readFileSync('app/api/sow/generate/route.ts', 'utf8')
    expect(src).toMatch(/isUuidString\(projectId\)/)
    expect(src).toMatch(/liveAfterAi/)
    expect(src.indexOf('liveAfterAi')).toBeGreaterThan(src.indexOf('buildSowContentPrompt'))
    expect(src).toMatch(/live SOW check failed/)
  })
  it('B1: credit prints as "USD -500" in the unsigned table', () => {
    const src = readFileSync('lib/pdf/sow-table.tsx', 'utf8')
    expect(src).toContain("`${currency} ${n < 0 ? '-' : ''}${body}`")
  })
})
