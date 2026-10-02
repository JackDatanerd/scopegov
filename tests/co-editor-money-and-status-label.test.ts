// tests/co-editor-money-and-status-label.test.ts
//
// CO-E1: the editor showed whole-unit-rounded money (formatCurrency) for figures that are stored and printed to the cent,
// and "-$0" for every zero on a credit. CO-P1: the CO PDF badge called a SENT change order "Pending Approval".

import { describe, it, expect } from 'vitest'
import { formatCoAmount } from '@/lib/documents/co-money'
import { CO_STATUS_LABEL, coWatermarkLabel } from '@/lib/pdf/co-watermark'

describe('formatCoAmount (CO editor money)', () => {
  it('keeps the cents the PDF and the client email show', () => {
    expect(formatCoAmount(100.02, 'USD', false)).toBe('$100.02')
    expect(formatCoAmount(386.66, 'USD', false)).toBe('$386.66')
    expect(formatCoAmount(0.45, 'USD', false)).toBe('$0.45')
    expect(formatCoAmount(1160, 'USD', false)).toBe('$1,160.00')
  })

  it("uses the currency's own minor units", () => {
    expect(formatCoAmount(12.345, 'KWD', false)).toContain('12.345')
    expect(formatCoAmount(1500, 'JPY', false)).toBe('¥1,500')
  })

  it('shows a credit as the reduction it is', () => {
    expect(formatCoAmount(250.5, 'USD', true)).toBe('-$250.50')
  })

  it('never prints a negative zero (blank rows / empty summary of a credit)', () => {
    expect(formatCoAmount(0, 'USD', true)).toBe('$0.00')
    expect(formatCoAmount(0, 'USD', false)).toBe('$0.00')
    expect(formatCoAmount(-0, 'USD', false)).toBe('$0.00')
    expect(formatCoAmount(0, 'USD', true)).not.toContain('-')
  })

  it('degrades to zero for a non-finite amount instead of printing NaN', () => {
    expect(formatCoAmount(NaN, 'USD', false)).toBe('$0.00')
  })

  it('falls back safely on an unknown currency code', () => {
    expect(() => formatCoAmount(10, 'XXXX', false)).not.toThrow()
  })
})

describe('CO PDF status badge', () => {
  it('calls a sent change order "Awaiting Response", not "Pending Approval"', () => {
    expect(CO_STATUS_LABEL.awaiting_response).toBe('Awaiting Response')
    expect(Object.values(CO_STATUS_LABEL)).not.toContain('Pending Approval')
  })

  it('has a label for every status the watermark knows', () => {
    for (const s of ['draft', 'awaiting_response', 'awaiting_countersignature', 'accepted', 'declined', 'countered',
      'closed', 'stalled', 'withdrawn', 'exception_granted', 'expired']) {
      expect(CO_STATUS_LABEL[s]).toBeTruthy()
    }
    expect(coWatermarkLabel('awaiting_response')).toBe('UNSIGNED')
  })
})
