import { describe, it, expect } from 'vitest'
import { isoDateInZone, formatDateInZone } from '@/lib/utils/timezone'
import { normalizeBillingAddress, parseClientInput } from '@/lib/utils/client-input'
import { redactClientDataRow } from '@/lib/audit/redact'

describe('clients pass 9 — B2: one zone for every Clients date', () => {
  const iso = '2026-09-04T22:30:00.000Z' // 01:30 on 5 Sept in Nairobi
  it('isoDateInZone (CSV) and formatDateInZone (table) agree on the day', () => {
    expect(isoDateInZone(iso, 'Africa/Nairobi')).toBe('2026-09-05')
    expect(formatDateInZone(iso, 'Africa/Nairobi')).toMatch(/^5 Sep/)
    expect(isoDateInZone(iso, 'UTC')).toBe('2026-09-04')
    expect(formatDateInZone(iso, 'UTC')).toMatch(/^4 Sep/)
    expect(isoDateInZone(iso, 'America/Los_Angeles')).toBe('2026-09-04')
  })
  it('falls back to UTC for an unusable zone and to empty for unusable input', () => {
    expect(isoDateInZone(iso, 'Not/AZone')).toBe('2026-09-04')
    expect(isoDateInZone(null, 'UTC')).toBe('')
    expect(isoDateInZone('junk', 'UTC')).toBe('')
  })
})

describe('clients pass 9 — B4: an untouched legacy address part does not block a save', () => {
  const long = 'x'.repeat(250)
  it('accepts an over-long part that equals what is already stored', () => {
    const r = normalizeBillingAddress({ line1: long, city: 'Nairobi' }, { line1: long, city: 'Nai' })
    expect(r.ok).toBe(true)
  })
  it('still rejects an over-long part that was newly written or changed', () => {
    expect(normalizeBillingAddress({ line1: long + 'y' }, { line1: long }).ok).toBe(false)
    expect(normalizeBillingAddress({ line1: long }, null).ok).toBe(false)
    expect(normalizeBillingAddress({ line1: long }, { line1: { a: 1 } }).ok).toBe(false)
    expect(normalizeBillingAddress({ line1: long }, [long]).ok).toBe(false)
  })
  it('parseClientInput threads the stored address through', () => {
    const body = { billingAddress: { line1: long, city: 'Nairobi' } }
    expect(parseClientInput(body, 'update', { currentBillingAddress: { line1: long } }).ok).toBe(true)
    expect(parseClientInput(body, 'update').ok).toBe(false)
  })
})

describe('clients pass 9 — B1: merge audit flag survives client-data redaction', () => {
  it('target_reactivated is a structural key, kept for viewers without VIEW_CLIENT_DATA', () => {
    const row = redactClientDataRow({ event_type: 'client.merged', entity_name: 'Acme', metadata: { target_reactivated: true, merged_from: { id: 'a', name: 'B', email: 'b@x.co' } } }, false)
    expect(row.metadata.target_reactivated).toBe(true)
  })
})
