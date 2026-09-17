import { describe, it, expect } from 'vitest'
import { mergePermissions, wouldOrphanManageRoles } from '@/lib/utils/admin-floor'

describe('mergePermissions', () => {
  it('overrides win per-key over role permissions, matching compute_effective_permissions()', () => {
    const merged = mergePermissions({ MANAGE_ROLES: true, VIEW_OWN_PROJECTS: true }, { MANAGE_ROLES: false })
    expect(merged).toEqual({ MANAGE_ROLES: false, VIEW_OWN_PROJECTS: true })
  })

  it('treats null role permissions and null overrides as empty objects', () => {
    expect(mergePermissions(null, null)).toEqual({})
  })
})

describe('wouldOrphanManageRoles', () => {
  // FIX (deep audit, RLS+permissions independent re-pass) regression:
  // leave_workspace_atomic (027/034/038) already guards the sole
  // MANAGE_ROLES holder leaving — this pins the equivalent guard for
  // PATCH /api/team/[id] and PATCH /api/team/roles/[id], which reach the
  // same "zero MANAGE_ROLES holders left" end state through role/override
  // edits instead.
  it('blocks when the change would leave zero active MANAGE_ROLES holders', () => {
    const members = [
      { id: 'm1', effectivePermissions: { MANAGE_ROLES: true } },
      { id: 'm2', effectivePermissions: { VIEW_OWN_PROJECTS: true } },
    ]
    // m1 is the sole holder and is losing MANAGE_ROLES
    const simulated = new Map([['m1', { MANAGE_ROLES: false }]])
    expect(wouldOrphanManageRoles(members, simulated)).toBe(true)
  })

  it('allows the change when another active member still holds MANAGE_ROLES', () => {
    const members = [
      { id: 'm1', effectivePermissions: { MANAGE_ROLES: true } },
      { id: 'm2', effectivePermissions: { MANAGE_ROLES: true } },
    ]
    const simulated = new Map([['m1', { MANAGE_ROLES: false }]])
    expect(wouldOrphanManageRoles(members, simulated)).toBe(false)
  })

  it('allows the change when the simulated result still keeps MANAGE_ROLES true (e.g. an override preserves it)', () => {
    const members = [{ id: 'm1', effectivePermissions: { MANAGE_ROLES: true } }]
    const simulated = new Map([['m1', { MANAGE_ROLES: true }]])
    expect(wouldOrphanManageRoles(members, simulated)).toBe(false)
  })

  it('members not present in the simulated map keep their current effective_permissions', () => {
    const members = [
      { id: 'm1', effectivePermissions: { MANAGE_ROLES: false } },
      { id: 'm2', effectivePermissions: { MANAGE_ROLES: true } },
    ]
    // Only m1 is being changed (and wasn't a holder anyway) — m2 is untouched and still holds it
    const simulated = new Map([['m1', { MANAGE_ROLES: false }]])
    expect(wouldOrphanManageRoles(members, simulated)).toBe(false)
  })

  it('an empty active-member list is treated as already orphaned', () => {
    expect(wouldOrphanManageRoles([], new Map())).toBe(true)
  })
})
