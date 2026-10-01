// tests/projects-dashboard-pass-3.test.ts
//
// Projects & Dashboard (section 7) independent pass:
//   B1  formatDate prints a date-only value ('YYYY-MM-DD') as that calendar day in every timezone
//   B2  project text fields reject NUL / lone surrogates with a clean error (not a 500 from Postgres)
//   B4  large id lists are chunked for `.in()` filters and merged correctly
import { describe, it, expect } from 'vitest'
import { formatDate } from '@/lib/utils/format'
import { parseProjectName, parseOptionalText } from '@/lib/utils/project-input'
import { chunkIds, fetchPagedIn, queryInChunks, ID_FILTER_CHUNK } from '@/lib/utils/paginate'

describe('B1 formatDate — date-only values', () => {
  it('keeps the calendar day regardless of the process timezone', () => {
    expect(formatDate('2026-10-01')).toBe('1 Oct 2026')
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026')
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026')
  })
  it('honours a caller-supplied timeZone and still formats real timestamps', () => {
    expect(formatDate('2026-10-01', { day: 'numeric', month: 'short', timeZone: 'UTC' })).toBe('1 Oct')
    expect(formatDate('2026-10-01T23:30:00Z', { day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' })).toBe('2 Oct')
    expect(formatDate(null)).toBe('—')
  })
})

describe('B2 project text — unstorable characters', () => {
  it('rejects NUL and lone surrogates in the name', () => {
    expect(parseProjectName('Acme\u0000site').ok).toBe(false)
    expect(parseProjectName('Acme\ud800').ok).toBe(false)
    expect(parseProjectName('Acme 🚀').ok).toBe(true) // a valid surrogate pair is fine
  })
  it('rejects them in optional text too', () => {
    expect(parseOptionalText('a\u0000b', 'Subtitle', 100).ok).toBe(false)
    expect(parseOptionalText('fine', 'Subtitle', 100)).toEqual({ ok: true, value: 'fine' })
  })
})

describe('B4 chunked id filters', () => {
  const ids = Array.from({ length: 250 }, (_, i) => `id-${String(i).padStart(3, '0')}`)

  it('splits into chunks of ID_FILTER_CHUNK', () => {
    const c = chunkIds(ids)
    expect(c.map(x => x.length)).toEqual([ID_FILTER_CHUNK, ID_FILTER_CHUNK, 50])
    expect(chunkIds([])).toEqual([])
  })

  it('fetchPagedIn merges every chunk and re-sorts', async () => {
    const res = await fetchPagedIn<{ id: string }>(
      ids,
      async (chunk, from, to) => ({ data: chunk.slice(from, to + 1).map(id => ({ id })), error: null, count: chunk.length }),
      { maxRows: 1000 },
      (a, b) => b.id.localeCompare(a.id),
    )
    expect(res.rows).toHaveLength(250)
    expect(res.total).toBe(250)
    expect(res.truncated).toBe(false)
    expect(res.rows[0].id).toBe('id-249')
  })

  it('fetchPagedIn reports truncation past maxRows', async () => {
    const res = await fetchPagedIn<{ id: string }>(
      ids,
      async (chunk, from, to) => ({ data: chunk.slice(from, to + 1).map(id => ({ id })), error: null, count: chunk.length }),
      { maxRows: 120 },
      (a, b) => a.id.localeCompare(b.id),
    )
    expect(res.truncated).toBe(true)
    expect(res.rows.length).toBeLessThanOrEqual(120)
  })

  it('fetchPagedIn throws when a chunk read errors (no silent partial list)', async () => {
    await expect(fetchPagedIn<any>(ids, async () => ({ data: null, error: { message: 'boom' } }), { maxRows: 10 }, () => 0))
      .rejects.toThrow('boom')
  })

  it('queryInChunks concatenates rows and surfaces the first error', async () => {
    const ok = await queryInChunks<string>(ids, async chunk => ({ data: chunk }))
    expect(ok.data).toHaveLength(250)
    expect(ok.error).toBeNull()
    let n = 0
    const bad = await queryInChunks<string>(ids, async chunk => (++n === 2 ? { data: null, error: { message: 'x' } } : { data: chunk }))
    expect(bad.data).toHaveLength(150)
    expect(bad.error?.message).toBe('x')
  })
})
