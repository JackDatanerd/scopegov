import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isoDateInZone } from '@/lib/utils/timezone'

// Section 12, B1: the invoice CSV printed Issued / Voided-on as the UTC date (first 10 chars of the ISO instant).
describe('invoice export dates use the workspace timezone (section 12, B1)', () => {
  it('an instant just after local midnight east of UTC is the local day, not the UTC day', () => {
    // 01:00 in Nairobi (UTC+3) on 15 Oct is 22:00 UTC on 14 Oct
    const sentAt = '2026-10-14T22:00:00.000Z'
    expect(sentAt.slice(0, 10)).toBe('2026-10-14')
    expect(isoDateInZone(sentAt, 'Africa/Nairobi')).toBe('2026-10-15')
  })

  it('UTC workspaces and unusable zones are unchanged', () => {
    expect(isoDateInZone('2026-10-14T22:00:00.000Z', 'UTC')).toBe('2026-10-14')
    expect(isoDateInZone('2026-10-14T22:00:00.000Z', 'Not/AZone')).toBe('2026-10-14')
  })

  it('null instants stay blank', () => {
    expect(isoDateInZone(null, 'Africa/Nairobi')).toBe('')
  })

  it('the export route converts sent_at / voided_at / file date and leaves paid_at (a date-received date) alone', () => {
    const src = readFileSync(join(__dirname, '..', 'app/api/invoices/export/route.ts'), 'utf-8')
    expect(src).toContain('isoDateInZone(r.sent_at, timeZone)')
    expect(src).toContain('isoDateInZone(r.voided_at, timeZone)')
    expect(src).toContain('const day = isoDateInZone(new Date(), timeZone)')
    expect(src).toContain("r.paid_at ? String(r.paid_at).slice(0, 10) : ''")
    expect(src).not.toContain('String(r.sent_at).slice(0, 10)')
  })
})
