import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { describeBilling } from '@/lib/sow/billing-summary'
import { pickSignatoryTitle } from '@/lib/sow/signatory'

const read = (p: string) => readFileSync(p, 'utf8')

describe('what the amount means', () => {
  it('a fixed project: the number is the whole project', () => {
    expect(describeBilling({ monthly: false, amount: 1200, currency: 'USD' }))
      .toBe('The whole project is USD 1,200.00, invoiced as one fee or in instalments.')
    // a term typed earlier for a retainer must not leak into a fixed project
    expect(describeBilling({ monthly: false, amount: 1200, currency: 'USD', termMonths: 12 })).not.toContain('month')
  })
  it('a retainer: the number is one month, with or without a term', () => {
    expect(describeBilling({ monthly: true, amount: '1200', currency: 'USD', termMonths: null }))
      .toBe('USD 1,200.00 is invoiced every month until the retainer ends. There is no fixed total.')
    expect(describeBilling({ monthly: true, amount: 1200, currency: 'USD', termMonths: '6' }))
      .toBe('USD 1,200.00 is invoiced every month for 6 months, USD 7,200.00 in total.')
    expect(describeBilling({ monthly: true, amount: 1200, currency: 'USD', termMonths: 1 })).toContain('for 1 month,')
    expect(describeBilling({ monthly: true, amount: 1200, currency: 'USD', termMonths: 0 })).toContain('no fixed total')
  })
  it('with no usable amount it says what to enter, in the right terms', () => {
    expect(describeBilling({ monthly: true, amount: '', currency: 'USD' })).toBe('Enter the fee for one month. It is invoiced every month.')
    expect(describeBilling({ monthly: false, amount: 0, currency: 'USD' })).toBe('Enter the price of the whole project.')
    expect(describeBilling({ monthly: false, amount: 'abc', currency: 'USD' })).toBe('Enter the price of the whole project.')
    expect(describeBilling({ monthly: true, amount: -5, currency: 'USD' })).toContain('Enter the fee')
  })
})

describe('remembering who signs', () => {
  const sows = [
    { metadata: { clientRepresentative: 'Faith Christine' } }, // newest names no position
    { metadata: { clientRepresentative: 'Jo Ng', clientRepresentativeTitle: 'CFO' } },
    { metadata: { clientRepresentative: 'Faith Christine', clientRepresentativeTitle: 'Director' } },
    null,
  ]
  it('returns the latest position named for this contact', () => {
    expect(pickSignatoryTitle('Faith Christine', sows)).toBe('Director')
    expect(pickSignatoryTitle(' faith  christine ', sows)).toBe('Director')
  })
  it("never lends one person's position to another, or invents one", () => {
    expect(pickSignatoryTitle('Jo Ng', sows)).toBe('CFO')
    expect(pickSignatoryTitle('Someone Else', sows)).toBe('')
    expect(pickSignatoryTitle('', sows)).toBe('')
    expect(pickSignatoryTitle('Faith Christine', [])).toBe('')
  })
})

describe('wiring', () => {
  it('the signatory route is scoped to the workspace, permission-gated and read-only', () => {
    const src = read('app/api/clients/[id]/signatory/route.ts')
    expect(src).toContain("hasPermission(session, 'CREATE_PROJECTS')")
    expect(src).toContain(".eq('workspace_id', session.workspaceId)")
    expect(src).toContain('isUuidString(id)')
    expect(src).not.toMatch(/\.(insert|update|delete|upsert)\(/)
  })
  it('the wizard fills company and title when a client is picked, without overwriting typed values', () => {
    const src = read('app/(app)/projects/new/page.tsx')
    expect(src).toContain('/api/clients/${id}/signatory')
    expect(src).toContain('setClientCompany(prev => prev || j.company)')
    expect(src).toContain('setSignerTitle(prev => prev || j.title)')
    expect(src).toContain('loadSignatory(c.id)')
  })
  it('the fee is asked on the brief step, prefilled from the brief, and saved before review', () => {
    const src = read('app/(app)/projects/new/page.tsx')
    expect(src).toContain("needed to draft the SOW")
    expect(src).toContain('brief.feeAmount > 0 && !(parseFloat(contractValue) > 0)')
    expect(src).toContain('async function goToReview()')
    expect(src).toContain('body: JSON.stringify({ contractValue: parseFloat(contractValue) || 0, currency }),')
    // the old dead-end message is gone
    expect(src).not.toContain('Use \\u2190 Back to add')
  })
  it('accepting the retainer offer also saves the brief\'s monthly figure when no amount was set', () => {
    const src = read('app/(app)/projects/new/page.tsx')
    expect(src).toContain("...(offer.feeAmount && !(parseFloat(contractValue) > 0) ? { contractValue: offer.feeAmount } : {})")
  })
  it('the same sentence explains the amount on basics, brief and review', () => {
    const src = read('app/(app)/projects/new/page.tsx')
    expect((src.match(/describeBilling\(/g) || []).length).toBeGreaterThanOrEqual(3)
  })
})
