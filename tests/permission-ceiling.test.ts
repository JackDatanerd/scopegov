import { describe, it, expect } from 'vitest'
import {
  permissionsBeyondCeiling,
  withinPermissionCeiling,
  roleWithinCeiling,
  permissionsBeyondActorForTarget,
} from '@/lib/utils/permission-ceiling'
import type { SessionUser } from '@/lib/supabase/types'

function actor(permissions: string[]): SessionUser {
  return {
    id: 'user-1',
    name: 'Test User',
    email: 'test@example.com',
    avatarUrl: null,
    workspaceId: 'ws-1',
    workspaceName: 'Test Workspace',
    agencyName: 'Test Agency',
    planTier: 'pro',
    trialEndsAt: null,
    onboardingCompletedAt: new Date().toISOString(),
    permissions: permissions as any,
    emailVerifiedAt: new Date().toISOString(),
    logoStoragePath: null,
    brandColour: null,
    hasPasswordIdentity: true,
  }
}

describe('permission-ceiling — privilege escalation guard', () => {
  it('allows granting a subset of what the actor already holds', () => {
    const a = actor(['MANAGE_ROLES', 'VIEW_ALL_PROJECTS', 'EDIT_SOW'])
    const beyond = permissionsBeyondCeiling(a, { VIEW_ALL_PROJECTS: true, EDIT_SOW: true })
    expect(beyond).toEqual([])
    expect(withinPermissionCeiling(a, { VIEW_ALL_PROJECTS: true })).toBe(true)
  })

  it('blocks granting a permission the actor does not hold — the core escalation case', () => {
    const a = actor(['MANAGE_ROLES']) // has MANAGE_ROLES, nothing else
    const beyond = permissionsBeyondCeiling(a, { MANAGE_ROLES: true, DELETE_PROJECTS: true })
    expect(beyond).toEqual(['DELETE_PROJECTS'])
    expect(withinPermissionCeiling(a, { MANAGE_ROLES: true, DELETE_PROJECTS: true })).toBe(false)
  })

  it('ignores keys explicitly set to false — a false entry grants nothing, so it is not beyond the ceiling', () => {
    const a = actor(['MANAGE_ROLES'])
    const beyond = permissionsBeyondCeiling(a, { MANAGE_ROLES: true, DELETE_PROJECTS: false })
    expect(beyond).toEqual([])
  })

  it('treats null/undefined permissions objects as granting nothing', () => {
    const a = actor([])
    expect(permissionsBeyondCeiling(a, null)).toEqual([])
    expect(permissionsBeyondCeiling(a, undefined)).toEqual([])
  })

  it('roleWithinCeiling: a null role grants nothing and is always within ceiling', () => {
    const a = actor([])
    expect(roleWithinCeiling(a, null)).toBe(true)
    expect(roleWithinCeiling(a, undefined)).toBe(true)
  })

  it('roleWithinCeiling: rejects assigning a role with permissions beyond the actor\'s own', () => {
    const a = actor(['MANAGE_ROLES', 'VIEW_OWN_PROJECTS'])
    const adminRole = { permissions: { MANAGE_ROLES: true, MANAGE_WORKSPACE_SETTINGS: true, DELETE_PROJECTS: true } }
    expect(roleWithinCeiling(a, adminRole)).toBe(false)
  })

  it('roleWithinCeiling: allows assigning a role that is a strict subset of the actor\'s permissions', () => {
    const a = actor(['MANAGE_ROLES', 'VIEW_OWN_PROJECTS', 'EDIT_SOW'])
    const juniorRole = { permissions: { VIEW_OWN_PROJECTS: true, EDIT_SOW: true } }
    expect(roleWithinCeiling(a, juniorRole)).toBe(true)
  })

  // FIX (section-by-section re-audit, RLS+permissions Finding 2)
  // regression: permissionsBeyondCeiling's "false grants nothing" rule is
  // correct for the GRANT direction, but PATCH /api/team/roles/[id] and
  // PATCH /api/team/[id] used to apply that same check when editing an
  // EXISTING role/member — meaning an all-false payload always passed,
  // with no floor check on what the target currently holds. That let a
  // bare MANAGE_ROLES holder zero out the Owner role (or strip an
  // individual member with permission_overrides) even though they held
  // none of what they were removing. Pin the floor-check helper so it
  // can't regress: an actor missing ANY permission the target currently,
  // effectively holds must be blocked — independent of what the
  // requested change actually does.
  it('permissionsBeyondActorForTarget blocks touching a target that currently holds more than the actor, even though the check is direction-agnostic', () => {
    const a = actor(['MANAGE_ROLES'])
    const ownerCurrentPermissions = { MANAGE_ROLES: true, MANAGE_WORKSPACE_SETTINGS: true, DELETE_PROJECTS: true }
    const outOfReach = permissionsBeyondActorForTarget(a, ownerCurrentPermissions)
    expect(outOfReach.sort()).toEqual(['DELETE_PROJECTS', 'MANAGE_WORKSPACE_SETTINGS'])
  })

  it('permissionsBeyondActorForTarget allows touching a target fully within the actor\'s ceiling', () => {
    const a = actor(['MANAGE_ROLES', 'MANAGE_WORKSPACE_SETTINGS', 'DELETE_PROJECTS'])
    const targetCurrentPermissions = { MANAGE_ROLES: true, DELETE_PROJECTS: true }
    expect(permissionsBeyondActorForTarget(a, targetCurrentPermissions)).toEqual([])
  })

  // FIX (build — RLS + permissions independent audit, HIGH): the ceiling used to
  // count only `=== true`, while getSession() granted on plain truthiness — so a
  // truthy NON-boolean value slipped under the ceiling and was then granted.
  // Pin the fail-closed behaviour: anything other than false/null/undefined is a
  // grant attempt.
  it('treats truthy NON-boolean values as grant attempts (type-confusion escalation)', () => {
    const a = actor(['MANAGE_ROLES'])
    const payload: any = { DELETE_PROJECTS: 1, MANAGE_BILLING: 'yes', APPROVE_DOCUMENTS: 'false', GRANT_EXCEPTIONS: {} }
    expect(permissionsBeyondCeiling(a, payload).sort()).toEqual(
      ['APPROVE_DOCUMENTS', 'DELETE_PROJECTS', 'GRANT_EXCEPTIONS', 'MANAGE_BILLING']
    )
    expect(withinPermissionCeiling(a, payload)).toBe(false)
  })

  it('still ignores false / null / undefined entries', () => {
    const a = actor(['MANAGE_ROLES'])
    const payload: any = { DELETE_PROJECTS: false, MANAGE_BILLING: null, APPROVE_DOCUMENTS: undefined }
    expect(permissionsBeyondCeiling(a, payload)).toEqual([])
  })
})
