import { describe, it, expect } from 'vitest'
import { parseIds, parseCursor, MAX_IDS } from '@/lib/utils/notification-input'

const U = '00000000-0000-4000-8000-000000000005'

describe('parseCursor', () => {
  it('passes a Postgres timestamptz through UNCHANGED — microseconds must survive or paging skips/repeats rows', () => {
    const c = parseCursor(`2026-09-20T10:00:05.123456+00:00|${U}`)
    expect(c).toEqual({ createdAt: '2026-09-20T10:00:05.123456+00:00', id: U })
  })
  it('accepts Z and no-fraction forms', () => {
    expect(parseCursor(`2026-09-20T10:00:05Z|${U}`)?.createdAt).toBe('2026-09-20T10:00:05Z')
  })
  it('rejects anything that could break out of the or=(…) filter string', () => {
    expect(parseCursor(`2026-09-20T10:00:05Z),id.eq.x|${U}`)).toBeNull()
    expect(parseCursor(`2026-09-20T10:00:05Z|${U},read.eq.true`)).toBeNull()
    expect(parseCursor(`2026-09-20T10:00:05Z|not-a-uuid`)).toBeNull()
  })
  it('rejects missing/garbled cursors', () => {
    expect(parseCursor(null)).toBeNull()
    expect(parseCursor('')).toBeNull()
    expect(parseCursor('nope')).toBeNull()
    expect(parseCursor(`2026-13-45T99:99:99Z|${U}`)).toBeNull()
  })
})

describe('parseIds', () => {
  it('accepts a list of uuids and dedupes', () => {
    expect(parseIds([U, U])).toEqual([U])
  })
  it('rejects empty, oversized, non-array and non-uuid input (Postgres would 400 the whole update)', () => {
    expect(parseIds([])).toBeNull()
    expect(parseIds('x')).toBeNull()
    expect(parseIds([U, 'abc'])).toBeNull()
    expect(parseIds([U, 5])).toBeNull()
    expect(parseIds(Array.from({ length: MAX_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`))).toBeNull()
  })
})
