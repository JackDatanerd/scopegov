import { describe, it, expect, vi } from 'vitest'
import { checkSeatLimit } from '@/lib/utils/seat-limit'

// FIX (deep audit, section 6 — flagship finding): the seat limit used to
// be enforced only at invite-creation time — nothing re-checked it at the
// point a membership actually becomes 'active' (accept, signup,
// reactivate). These tests pin the shared helper those three call sites
// now share, so the three activation paths can't silently drift back out
// of sync with invite-creation's own check the way they did before.

// Records every query the helper builds (each is a list of [method, args]) and resolves each with
// the same { count, error }, so a test can assert both WHAT was asked and what came back.
function mockService(count: number | null, error: unknown = null) {
  const queries: Array<Array<[string, any[]]>> = []
  const chain = (ops: Array<[string, any[]]>): any => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (res: any, rej: any) => { queries.push(ops); return Promise.resolve({ count, error }).then(res, rej) }
      }
      return (...args: any[]) => chain([...ops, [prop, args]])
    },
  })
  const fromFn = vi.fn((_table: string) => chain([]))
  return { service: { from: fromFn }, fromFn, queries }
}
const called = (q: Array<[string, any[]]>, name: string) => q.find(([n]) => n === name)?.[1]

describe('checkSeatLimit', () => {
  it('allows activation when the plan has no seat cap at all (unknown/unlimited tier)', async () => {
    const { service } = mockService(999)
    const result = await checkSeatLimit(service, 'ws-1', 'not-a-real-tier', ['active'])
    expect(result.ok).toBe(true)
  })

  it('allows activation when the counted total is strictly below the seat limit', async () => {
    // starter = 2 seats
    const { service } = mockService(1)
    const result = await checkSeatLimit(service, 'ws-1', 'starter', ['active'])
    expect(result.ok).toBe(true)
  })

  it('blocks activation when the counted total already equals the seat limit', async () => {
    const { service } = mockService(2)
    const result = await checkSeatLimit(service, 'ws-1', 'starter', ['active'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('2-seat')
      expect(result.message).toContain('Starter')
    }
  })

  it('blocks activation when the counted total is already over the seat limit', async () => {
    const { service } = mockService(5)
    const result = await checkSeatLimit(service, 'ws-1', 'solo', ['active'])
    expect(result.ok).toBe(false)
  })

  it('scopes the count query to the workspace and the given statuses', async () => {
    const { service, fromFn, queries } = mockService(0)
    await checkSeatLimit(service, 'ws-42', 'pro', ['active'])
    expect(fromFn).toHaveBeenCalledWith('workspace_members')
    expect(queries).toHaveLength(1)
    expect(called(queries[0], 'select')).toEqual(['id', { count: 'exact', head: true }])
    expect(called(queries[0], 'eq')).toEqual(['workspace_id', 'ws-42'])
    expect(called(queries[0], 'in')).toEqual(['status', ['active']])
  })

  it('counts a pending invite only while its expiry is still in the future', async () => {
    // An invite past its expiry no longer holds a seat, even before the daily cron marks it 'expired'.
    const { service, queries } = mockService(0)
    await checkSeatLimit(service, 'ws-42', 'pro', ['active', 'invited'])
    expect(queries).toHaveLength(2)
    const invited = queries.find(q => (called(q, 'eq') || []).length && q.some(([n, a]) => n === 'eq' && a[0] === 'status' && a[1] === 'invited'))!
    expect(invited).toBeTruthy()
    const or = called(invited, 'or')![0] as string
    expect(or).toMatch(/^invite_token_expires_at\.is\.null,invite_token_expires_at\.gt\.\d{4}-\d{2}-\d{2}T/)
  })

  it('adds active members and live invites together against the limit', async () => {
    // starter = 2 seats; each of the two queries reports 1 → 2 in use → full
    const { service } = mockService(1)
    const result = await checkSeatLimit(service, 'ws-1', 'starter', ['active', 'invited'])
    expect(result.ok).toBe(false)
  })

  it('fails open on a DB error rather than locking a real member out', async () => {
    const { service } = mockService(null, { message: 'connection reset' })
    const result = await checkSeatLimit(service, 'ws-1', 'starter', ['active'])
    expect(result.ok).toBe(true)
  })
})
