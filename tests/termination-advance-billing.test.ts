import { describe, it, expect } from 'vitest'
import { terminationClauseHtml } from '@/lib/documents/standard-clauses'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('retainer termination follows the service period, not the invoice date', () => {
  for (const [label, input] of [['open-ended', { retainer: true }], ['fixed term', { retainer: true, retainerMonths: 6 }]] as const) {
    describe(label, () => {
      const t = text(terminationClauseHtml(input))
      it('no longer makes every invoice issued before the effective date payable', () => {
        expect(t).not.toMatch(/fees invoiced up to the effective date/i)
      })
      it('owes each month that begins on or before the effective date, in full', () => {
        expect(t).toContain('each monthly period that begins on or before the effective date of termination')
        expect(t).toContain('including the period in progress when notice is given')
      })
      it('cancels and refunds a later period billed in advance', () => {
        expect(t).toContain('No fee is payable for a monthly period that begins after the effective date of termination')
        expect(t).toContain('An invoice already issued for such a period is cancelled, and any amount already paid for it is refunded')
      })
      it('keeps change-order and delivered-work fees payable', () => {
        expect(t).toContain('change orders accepted, and work delivered, before the effective date')
      })
      it('keeps the effective-date rule and the return of materials', () => {
        expect(t).toContain('end of the monthly period in which the written notice is given')
        expect(t).toContain('return or delete')
      })
    })
  }
  it('same inputs, same text', () => {
    expect(terminationClauseHtml({ retainer: true })).toBe(terminationClauseHtml({ retainer: true, retainerMonths: null }))
  })
  it('fixed-fee termination is unchanged', () => {
    const t = text(terminationClauseHtml({ retainer: false }))
    expect(t).toContain('pay for all work performed and deliverables completed up to the effective date')
    expect(t).not.toContain('monthly period')
  })
})
