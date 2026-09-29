import { describe, it, expect } from 'vitest'
import { isUuidString } from '@/lib/utils/uuid'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { addDaysToDateString, dateStringInZone } from '@/lib/utils/timezone'

function fakeService(rows: any[]) {
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (res: any) => res({ data: rows, error: null })
      return () => chain
    },
  })
  return { from: () => chain }
}

describe('isUuidString (B3)', () => {
  it('accepts UUIDs of either case', () => {
    expect(isUuidString('3f2b8c1e-9d4a-4b7e-8a21-0c5d6e7f8a90')).toBe(true)
    expect(isUuidString('3F2B8C1E-9D4A-4B7E-8A21-0C5D6E7F8A90')).toBe(true)
  })
  it('rejects anything else — a non-UUID must never reach Postgres (22P02 → 500)', () => {
    for (const v of ['abc', '', '3f2b8c1e', '3f2b8c1e-9d4a-4b7e-8a21-0c5d6e7f8a9', "1' or '1'='1", null, undefined, 42, {}, []])
      expect(isUuidString(v as any)).toBe(false)
  })
})

describe('withPrimaryContactCc cap (B2)', () => {
  const rows = [{ email: 'p@x.com' }, { email: 'q@x.com' }]
  const ten = Array.from({ length: 10 }, (_, i) => `c${i}@x.com`)
  it('adds nothing when the client\'s own CC list already holds the maximum', async () => {
    expect(await withPrimaryContactCc(fakeService(rows), 'c1', 'a@x.com', ten, 'invoice')).toEqual(ten)
  })
  it('adds only what fits', async () => {
    const nine = ten.slice(0, 9)
    expect(await withPrimaryContactCc(fakeService(rows), 'c1', 'a@x.com', nine, 'invoice')).toEqual([...nine, 'p@x.com'])
  })
  it('never routes past 10 in total', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ email: `r${i}@x.com` }))
    expect((await withPrimaryContactCc(fakeService(many), 'c1', 'a@x.com', [], 'co')).length).toBe(10)
  })
})

describe('client-calendar helpers (G2)', () => {
  // 20:00 UTC on 30 Sep — already 1 Oct in Auckland (NZDT, UTC+13), still 30 Sep in Nairobi and Pago Pago.
  const at = new Date('2026-09-30T20:00:00Z')
  it('reads the date in the given zone', () => {
    expect(dateStringInZone('Pacific/Auckland', at)).toBe('2026-10-01')
    expect(dateStringInZone('Africa/Nairobi', at)).toBe('2026-09-30')
    expect(dateStringInZone('Pacific/Pago_Pago', at)).toBe('2026-09-30')
    expect(dateStringInZone('UTC', at)).toBe('2026-09-30')
  })
  it('falls back to UTC for an unset or unusable zone', () => {
    expect(dateStringInZone(null, at)).toBe('2026-09-30')
    expect(dateStringInZone('Not/AZone', at)).toBe('2026-09-30')
  })
  it('does calendar arithmetic across month and year ends', () => {
    expect(addDaysToDateString('2026-09-30', 3)).toBe('2026-10-03')
    expect(addDaysToDateString('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysToDateString('2026-12-31', 1)).toBe('2027-01-01')
  })
})
