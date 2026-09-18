import { describe, it, expect, vi } from 'vitest'
import { checkSeatLimit } from '@/lib/utils/seat-limit'

// FIX (deep audit, section 6 — flagship finding): the seat limit used to
// be enforced only at invite-creation time — nothing re-checked it at the
// point a membership actually becomes 'active' (accept, signup,
// reactivate). These tests pin the shared helper those three call sites
// now share, so the three activation paths can't silently drift back out
// of sync with invite-creation's own check the way they did before.

function mockService(count: number | null, error: unknown = null) {
  const inFn = vi.fn(async () => ({ count, error }))
  const eqFn = vi.fn(() => ({ in: inFn }))
  const selectFn = vi.fn(() => ({ eq: eqFn }))
  const fromFn = vi.fn(() => ({ select: selectFn }))
  return { service: { from: fromFn }, fromFn, selectFn, eqFn, inFn }
}

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
    const { service, fromFn, selectFn, eqFn, inFn } = mockService(0)
    await checkSeatLimit(service, 'ws-42', 'pro', ['active', 'invited'])
    expect(fromFn).toHaveBeenCalledWith('workspace_members')
    expect(selectFn).toHaveBeenCalledWith('id', { count: 'exact', head: true })
    expect(eqFn).toHaveBeenCalledWith('workspace_id', 'ws-42')
    expect(inFn).toHaveBeenCalledWith('status', ['active', 'invited'])
  })

  it('fails open on a DB error rather than locking a real member out', async () => {
    const { service } = mockService(null, { message: 'connection reset' })
    const result = await checkSeatLimit(service, 'ws-1', 'starter', ['active'])
    expect(result.ok).toBe(true)
  })
})
