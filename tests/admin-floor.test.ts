import { describe, it, expect } from 'vitest'
import {
  mergePermissions,
  wouldOrphanManageRoles,
  protectedPermissionsOrphanedBy,
  describeProtectedPermission,
} from '@/lib/utils/admin-floor'

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

describe('protectedPermissionsOrphanedBy', () => {
  // FIX (deep audit, Team & Invites section) regression: the guard above
  // was hardcoded to MANAGE_ROLES, while leave_workspace_atomic
  // (027/034/038) — the RPC whose reasoning it re-implements — protects
  // MANAGE_WORKSPACE_SETTINGS as well. That let the sole holder of
  // MANAGE_WORKSPACE_SETTINGS strip it via a role edit or a member
  // override, and the permission-ceiling rule ("you can only grant what
  // you already hold") then made it impossible for anyone to grant back —
  // permanently losing Settings → Workspace/Branding/Defaults/Guardian/
  // Danger zone, approval workflows, workspace deletion and ownership
  // transfer. These pin BOTH permissions.
  it('reports MANAGE_WORKSPACE_SETTINGS when the change would leave zero holders', () => {
    const members = [
      { id: 'm1', effectivePermissions: { MANAGE_ROLES: true, MANAGE_WORKSPACE_SETTINGS: true } },
      { id: 'm2', effectivePermissions: { MANAGE_ROLES: true } },
    ]
    // m1 keeps MANAGE_ROLES (m2 has it too) but is the sole settings holder
    const simulated = new Map([['m1', { MANAGE_ROLES: true, MANAGE_WORKSPACE_SETTINGS: false }]])
    expect(protectedPermissionsOrphanedBy(members, simulated)).toEqual(['MANAGE_WORKSPACE_SETTINGS'])
  })

  it('reports both when a change orphans both at once', () => {
    const members = [{ id: 'm1', effectivePermissions: { MANAGE_ROLES: true, MANAGE_WORKSPACE_SETTINGS: true } }]
    const simulated = new Map([['m1', {}]])
    expect(protectedPermissionsOrphanedBy(members, simulated).sort())
      .toEqual(['MANAGE_ROLES', 'MANAGE_WORKSPACE_SETTINGS'])
  })

  it('reports nothing when another active member still holds each permission', () => {
    const members = [
      { id: 'm1', effectivePermissions: { MANAGE_ROLES: true, MANAGE_WORKSPACE_SETTINGS: true } },
      { id: 'm2', effectivePermissions: { MANAGE_ROLES: true, MANAGE_WORKSPACE_SETTINGS: true } },
    ]
    const simulated = new Map([['m1', {}]])
    expect(protectedPermissionsOrphanedBy(members, simulated)).toEqual([])
  })

  it('wouldOrphanManageRoles stays true to its original meaning', () => {
    const members = [{ id: 'm1', effectivePermissions: { MANAGE_ROLES: true, MANAGE_WORKSPACE_SETTINGS: true } }]
    // Only settings is being dropped — the legacy helper must NOT fire
    const simulated = new Map([['m1', { MANAGE_ROLES: true }]])
    expect(wouldOrphanManageRoles(members, simulated)).toBe(false)
  })
})

describe('describeProtectedPermission', () => {
  it('renders a human label rather than echoing the constant at the user', () => {
    expect(describeProtectedPermission('MANAGE_ROLES')).toBe('manage roles')
    expect(describeProtectedPermission('MANAGE_WORKSPACE_SETTINGS')).toBe('manage workspace settings')
  })
})
