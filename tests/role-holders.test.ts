// tests/role-holders.test.ts
//
// FIX (deep audit, Team & Invites independent re-pass — bug): see
// lib/utils/role-holders.ts's own comment. The Roles tab used to count
// only active members, so a role held solely by a pending invite or a
// deactivated member showed "0 Members" with a Delete button that looked
// safe but would 409. These cover the counting logic the fix now runs on.
import { describe, it, expect } from 'vitest'
import { roleHolderCounts } from '@/lib/utils/role-holders'

describe('roleHolderCounts', () => {
  it('counts active members for the given role only', () => {
    const r = roleHolderCounts('role-a', {
      members: [{ role_id: 'role-a' }, { role_id: 'role-a' }, { role_id: 'role-b' }],
    })
    expect(r).toEqual({ active: 2, pending: 0, deactivated: 0, total: 2 })
  })

  it('a role with zero active members but a pending invite is NOT "0 holders"', () => {
    // This is the exact scenario the bug produced: memberCount === 0 read as
    // "safe to delete" even though a pending invite still used the role.
    const r = roleHolderCounts('role-a', {
      members: [],
      pendingInvites: [{ role_id: 'role-a' }],
    })
    expect(r.active).toBe(0)
    expect(r.total).toBe(1) // must NOT be 0 — this is what used to unlock the Delete button
  })

  it('a role with zero active members but a deactivated holder is NOT "0 holders"', () => {
    const r = roleHolderCounts('role-a', {
      members: [],
      deactivatedMembers: [{ role_id: 'role-a' }],
    })
    expect(r.active).toBe(0)
    expect(r.total).toBe(1)
  })

  it('sums active + pending + expired + deactivated across all four lists', () => {
    const r = roleHolderCounts('role-a', {
      members: [{ role_id: 'role-a' }],
      pendingInvites: [{ role_id: 'role-a' }],
      expiredInvites: [{ role_id: 'role-a' }, { role_id: 'role-a' }],
      deactivatedMembers: [{ role_id: 'role-a' }],
    })
    expect(r).toEqual({ active: 1, pending: 3, deactivated: 1, total: 5 })
  })

  it('missing/omitted lists (deactivatedMembers, expiredInvites default to []) count as zero, not a crash', () => {
    expect(() => roleHolderCounts('role-a', { members: [] })).not.toThrow()
    const r = roleHolderCounts('role-a', { members: [{ role_id: 'role-a' }] })
    expect(r).toEqual({ active: 1, pending: 0, deactivated: 0, total: 1 })
  })

  it('a role nobody holds in any status is genuinely 0 — the Delete button should be enabled', () => {
    const r = roleHolderCounts('role-a', {
      members: [{ role_id: 'role-b' }],
      pendingInvites: [{ role_id: 'role-b' }],
      expiredInvites: [],
      deactivatedMembers: [{ role_id: 'role-c' }],
    })
    expect(r.total).toBe(0)
  })
})
