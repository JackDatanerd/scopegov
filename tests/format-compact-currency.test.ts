import { describe, it, expect } from 'vitest'
import { formatCurrency } from '@/lib/utils/format'

describe('formatCurrency (compact)', () => {
  it('leaves sub-thousand values to the normal formatter', () => {
    expect(formatCurrency(500, 'USD', true)).toBe('$500')
    expect(formatCurrency(-500, 'USD', true)).toBe('-$500')
  })
  it('uses k with one decimal, trimming a trailing .0', () => {
    expect(formatCurrency(1500, 'USD', true)).toBe('USD 1.5k')
    expect(formatCurrency(12000, 'USD', true)).toBe('USD 12k')
  })
  it('puts the sign before the currency, matching a "+" prefix on a positive delta', () => {
    expect(formatCurrency(-1500, 'USD', true)).toBe('-USD 1.5k')
    expect(`+${formatCurrency(1500, 'USD', true)}`).toBe('+USD 1.5k')
  })
  it('rolls values that round to 1000k over to M instead of "USD 1000.0k"', () => {
    expect(formatCurrency(999940, 'USD', true)).toBe('USD 999.9k')
    expect(formatCurrency(999960, 'USD', true)).toBe('USD 1M')
  })
  it('uses M and B for large values', () => {
    expect(formatCurrency(2500000, 'USD', true)).toBe('USD 2.5M')
    expect(formatCurrency(-2500000, 'KES', true)).toBe('-KES 2.5M')
    expect(formatCurrency(1e9, 'USD', true)).toBe('USD 1B')
  })
})
