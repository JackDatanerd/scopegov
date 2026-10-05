import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { amountsMentioned, amountsStated } from '@/lib/sow/validate-send'
import { parseTableAmount } from '@/lib/sow/table-schema'
import { ensureContractValueStated, AI_SECTION_IDS } from '@/lib/ai/sow-content'

describe('SOW lifecycle pass 14', () => {
  it('B2: lakh grouping is one amount, agreeing with parseTableAmount', () => {
    expect(amountsStated('Fee of INR 1,00,000 payable on signing')).toEqual([100000])
    expect(amountsMentioned('INR 12,34,567.50')).toEqual([1234567.5])
    expect(parseTableAmount('1,00,000')).toBe(100000)
  })
  it('B2: western grouping and plain numbers are unchanged', () => {
    expect(amountsStated('USD 12,345,678 and 1,500.50 and 5000')).toEqual([12345678, 1500.5, 5000])
    expect(amountsStated('12,500. 50% due')).toEqual([12500])
  })
  it('B2: a value stated in lakh format is not re-appended', () => {
    const html = '<p>Total INR 1,00,000.</p>'
    expect(ensureContractValueStated(html, 100000, 'INR')).toBe(html)
  })
  it('B1: the Improve button is gated on the ids the route accepts', () => {
    expect(AI_SECTION_IDS).not.toContain('parties')
    expect(AI_SECTION_IDS).not.toContain('governing_law')
    expect(AI_SECTION_IDS).not.toContain('signature')
    const src = fs.readFileSync(path.join(process.cwd(), 'components/sow/SowEditor.tsx'), 'utf8')
    expect(src).toMatch(/AI_SECTION_IDS\.includes\(current\.id\)/)
  })
})
