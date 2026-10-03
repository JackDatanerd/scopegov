import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { formatRate, formatAmount } from '@/lib/utils/money'

describe('formatRate keeps the decimals a stored rate really has', () => {
  it('does not round 0.125 to 0.13 (line total is quantity x exact rate)', () => {
    expect(formatRate(0.125, 'USD')).toBe('0.125')
    expect(formatAmount(0.125, 'USD')).toBe('0.13')
  })
  it('still pads to the currency minor units', () => {
    expect(formatRate(145, 'USD')).toBe('145.00')
    expect(formatRate(1234.5, 'KES')).toBe('1,234.50')
    expect(formatRate(1500, 'JPY')).toBe('1,500')
  })
  it('is safe on garbage', () => {
    expect(formatRate(null, 'USD')).toBe('0.00')
    expect(formatRate('abc', 'USD')).toBe('0.00')
  })
})

describe('client-facing email routes refuse an unverified member', () => {
  const src = (p: string) => readFileSync(p, 'utf8')
  it('invoice remind returns 403', () => {
    expect(src('app/api/invoices/[id]/remind/route.ts')).toMatch(/!session\.emailVerifiedAt[\s\S]{0,120}403/)
  })
  it('sow remind returns 403', () => {
    expect(src('app/api/sow/[id]/remind/route.ts')).toMatch(/!session\.emailVerifiedAt[\s\S]{0,120}403/)
  })
  it('invoice void, dispute-resolve and sow withdraw skip the email', () => {
    expect(src('app/api/invoices/[id]/void/route.ts')).toMatch(/!session\.emailVerifiedAt\) clientNotified = false/)
    expect(src('app/api/invoices/[id]/dispute-resolve/route.ts')).toMatch(/session\.emailVerifiedAt\) \{/)
    expect(src('app/api/sow/[id]/withdraw/route.ts')).toMatch(/!session\.emailVerifiedAt\) emailed = false/)
  })
})
