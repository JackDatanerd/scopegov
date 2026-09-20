import { describe, it, expect } from 'vitest'
import { fetchAll } from '@/lib/utils/fetch-all'

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }))

describe('fetchAll', () => {
  it('pages past the 1000-row PostgREST cap', async () => {
    const all = rows(2500)
    const calls: Array<[number, number]> = []
    const out = await fetchAll('t', async (from, to) => { calls.push([from, to]); return { data: all.slice(from, to + 1), error: null } })
    expect(out).toHaveLength(2500)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it('stops after a short page without an extra request', async () => {
    let n = 0
    await fetchAll('t', async () => { n++; return { data: rows(3), error: null } })
    expect(n).toBe(1)
  })
  it('THROWS on a query error instead of returning an empty list (the silent-success bug)', async () => {
    await expect(fetchAll('co-stall select', async () => ({ data: null, error: { message: 'boom' } })))
      .rejects.toThrow('co-stall select: boom')
  })
  it('respects the safety ceiling', async () => {
    const out = await fetchAll('t', async (from) => ({ data: rows(1000).map((r, i) => ({ id: from + i })), error: null }), 2000)
    expect(out).toHaveLength(2000)
  })
})
