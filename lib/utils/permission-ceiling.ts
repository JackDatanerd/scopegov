// lib/utils/permission-ceiling.ts
//
// FIX (audit round 4, finding #1 — CRITICAL): nothing in the permission
// model enforced a ceiling on what a MANAGE_ROLES (or INVITE_MEMBERS)
// holder could grant. Three routes let a member escalate themselves (or
// anyone) straight to full workspace admin:
//   - POST  /api/team/roles       — create a role with ANY permissions
//   - PATCH /api/team/roles/[id]  — edit an EXISTING role's permissions
//                                   (which the trigger then propagates to
//                                   every member currently holding it)
//   - PATCH /api/team/[id]        — set permission_overrides directly on
//                                   ANY member row, including your own —
//                                   unlike DELETE, there was no
//                                   self-action guard here
// plus a milder version on invite (assigning a role to a brand-new
// member you couldn't otherwise grant).
//
// The fix, per product decision: you can only grant a permission you
// already hold yourself. MANAGE_ROLES lets you shape the workspace's
// role structure — it was never meant to be a blank check to mint your
// own admin access. This is the single choke point for that rule so it
// can't drift across the three call sites again.

import type { Permission, SessionUser } from '@/lib/supabase/types'
import { hasPermission } from '@/lib/auth/session'

// `permissions` objects in this codebase are jsonb — arbitrary string
// keys, not guaranteed to be valid Permission values (a stale role from
// before a permission was renamed/removed, or a client sending garbage).
// Only the TRUE keys matter for the ceiling check: a `false` entry never
// grants anything, so it's not something the actor needs to already hold.
function grantedKeys(permissions: Record<string, unknown> | null | undefined): string[] {
  if (!permissions) return []
  return Object.keys(permissions).filter(k => permissions[k] === true)
}

// Returns the subset of `permissions`'s true keys that the actor does NOT
// currently hold — i.e. exactly what they're trying to grant beyond their
// own ceiling. Empty array = the grant is within bounds.
export function permissionsBeyondCeiling(
  actor: SessionUser,
  permissions: Record<string, unknown> | null | undefined
): string[] {
  const held = new Set(actor.permissions as string[])
  return grantedKeys(permissions).filter(k => !held.has(k))
}

export function withinPermissionCeiling(
  actor: SessionUser,
  permissions: Record<string, unknown> | null | undefined
): boolean {
  return permissionsBeyondCeiling(actor, permissions).length === 0
}

// Convenience for the single-role-assignment case (assigning role_id to a
// member, on invite or on PATCH /api/team/[id]) — the role's OWN
// permissions must fit inside what the actor holds, same rule, just
// checked against a role row instead of a raw overrides object.
export function roleWithinCeiling(actor: SessionUser, role: { permissions: Record<string, unknown> } | null | undefined): boolean {
  if (!role) return true // no role / null role_id grants nothing
  return withinPermissionCeiling(actor, role.permissions)
}

// FIX (section-by-section re-audit, RLS+permissions Finding 2 —
// CRITICAL): permissionsBeyondCeiling() only ever checks the NEW `true`
// keys being requested, by design (a `false` entry revokes, it doesn't
// escalate). But PATCH /api/team/roles/[id] and PATCH /api/team/[id]
// applied that exact same check when editing an EXISTING role/member's
// permissions — which means setting every key to `false` always passes
// (grantedKeys() returns nothing to check), with no floor check on what
// the target CURRENTLY holds. Since the "Owner" role is nothing more
// than an ordinarily-editable row (name='Owner', permissions=all-true)
// with no structural protection anywhere, any member holding bare
// MANAGE_ROLES could zero out the Owner role's permissions entirely —
// trg_role_permissions_propagate (migration 001) then instantly rewrites
// effective_permissions for every member holding it, including the real
// founder. The identical gap applies per-member via permission_overrides
// on PATCH /api/team/[id].
//
// Fix: a second, independent check alongside the ceiling — before
// touching a role or a member's overrides, the actor must already hold
// EVERYTHING the target currently, effectively has. You can't touch a
// principal whose current permission set isn't fully inside your own
// ceiling, regardless of which direction the requested change points.
export function permissionsBeyondActorForTarget(
  actor: SessionUser,
  targetCurrentPermissions: Record<string, unknown> | null | undefined
): string[] {
  return permissionsBeyondCeiling(actor, targetCurrentPermissions)
}
