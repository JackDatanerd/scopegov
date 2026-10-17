import { describe, it, expect } from 'vitest'
import { toTitleCase } from '@/lib/documents/title-case'
import { dueDateExceedsTerm, effectivePaymentTermsDays, latestDueDate, sowPaymentTermsDays } from '@/lib/documents/payment-terms'

describe('toTitleCase', () => {
  it('capitalises a sentence-case draft title', () => {
    expect(toTitleCase('Influencer and affiliate partner identification')).toBe('Influencer and Affiliate Partner Identification')
  })
  it('keeps small words lower except first and last', () => {
    expect(toTitleCase('scope of work for the launch')).toBe('Scope of Work for the Launch')
    expect(toTitleCase('what to do on')).toBe('What to Do On')
  })
  it('leaves brands, acronyms and numbers alone', () => {
    expect(toTitleCase('TikTok and iOS asset refresh')).toBe('TikTok and iOS Asset Refresh')
    expect(toTitleCase('DTC landing page v2')).toBe('DTC Landing Page v2')
  })
  it('handles hyphens', () => {
    expect(toTitleCase('one-time brand audit')).toBe('One-Time Brand Audit')
  })
  it('is idempotent and tolerant of empty input', () => {
    const once = toTitleCase('Additional homepage redesign')
    expect(toTitleCase(once)).toBe(once)
    expect(toTitleCase('')).toBe('')
  })
})

describe('payment terms', () => {
  it('reads only a valid frozen term', () => {
    expect(sowPaymentTermsDays({ paymentTermsDays: 14 })).toBe(14)
    expect(sowPaymentTermsDays({ paymentTermsDays: 0 })).toBeNull()
    expect(sowPaymentTermsDays(null)).toBeNull()
  })
  it('prefers the SOW term over the workspace default', () => {
    expect(effectivePaymentTermsDays({ paymentTermsDays: 14 }, 30)).toBe(14)
    expect(effectivePaymentTermsDays({}, 30)).toBe(30)
    expect(effectivePaymentTermsDays({}, null)).toBeNull()
  })
  it('counts the term on the workspace calendar, not the browser or UTC one', () => {
    // 23:30 on Oct 16 in Houston (CDT) is already Oct 17 in UTC and Nairobi
    const issued = new Date('2026-10-17T04:30:00Z')
    expect(latestDueDate(issued, 14, 'America/Chicago')).toBe('2026-10-30')
    expect(latestDueDate(issued, 14, 'Africa/Nairobi')).toBe('2026-10-31')
  })
  it('flags only a due date later than the period allows', () => {
    const issued = new Date('2026-10-17T04:30:00Z')
    expect(dueDateExceedsTerm('2026-10-31', issued, 14, 'America/Chicago')).toEqual({ due: '2026-10-31', latest: '2026-10-30', issued: '2026-10-16' })
    expect(dueDateExceedsTerm('2026-10-30', issued, 14, 'America/Chicago')).toBeNull()
    expect(dueDateExceedsTerm('2026-10-20', issued, 14, 'America/Chicago')).toBeNull()
    expect(dueDateExceedsTerm('2026-10-31', issued, null, 'America/Chicago')).toBeNull()
    expect(dueDateExceedsTerm(null, issued, 14, 'America/Chicago')).toBeNull()
  })
})
