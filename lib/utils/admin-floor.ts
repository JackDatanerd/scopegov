// lib/utils/admin-floor.ts
//
// FIX (deep audit, RLS+permissions independent re-pass — CRITICAL):
// leave_workspace_atomic() (migrations 027/034/038) blocks the sole
// MANAGE_ROLES (and MANAGE_WORKSPACE_SETTINGS) holder from leaving a
// workspace, specifically so the permission system itself can never be
// permanently orphaned — migration 034's own words: "a one-way lockout of
// the permission system itself, with no self-service recovery." That
// floor check lives ONLY inside that one RPC, reached only when someone
// leaves.
//
// Every other path that can change who holds MANAGE_ROLES had no
// equivalent protection, even though they reach the exact same end
// state:
//   - PATCH /api/team/[id] — editing your own or a peer's
//     permission_overrides / role_id (compute_effective_permissions(),
//     migration 001, recomputes effective_permissions synchronously)
//   - PATCH /api/team/roles/[id] — editing a role's own permissions in
//     place, which trg_role_permissions_propagate (migration 001) then
//     applies to every member currently holding that role
//
// Both already have ceiling/floor checks (lib/utils/permission-ceiling.ts)
// that stop an actor from touching permissions/people beyond their own
// reach — but neither stops an actor from legally, within their own
// ceiling, removing the LAST MANAGE_ROLES holder in the workspace
// (frequently themselves), since a floor check against "what the actor
// already holds" always passes trivially when the actor is acting on
// their own permissions. This is the shared check both routes call
// before writing: given the workspace's current active membership and a
// simulated post-change effective_permissions for whichever member(s)
// the change touches, would any active member still hold MANAGE_ROLES
// afterward?

// Mirrors compute_effective_permissions()'s merge logic (migration 001)
// in JS, for simulating a member's post-change effective_permissions
// before writing anything, so this check can run without a speculative
// DB write. Overrides win per-key, same as the trigger.
export function mergePermissions(
  rolePermissions: Record<string, unknown> | null | undefined,
  overrides: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return { ...(rolePermissions || {}), ...(overrides || {}) }
}

export interface ActiveMemberSnapshot {
  id: string
  effectivePermissions: Record<string, unknown> | null
}

// FIX (deep audit, Team & Invites section — HIGH): this guard was
// hardcoded to MANAGE_ROLES, but the RPC whose reasoning it was built
// from protects TWO permissions, not one. leave_workspace_atomic blocks
// the sole MANAGE_WORKSPACE_SETTINGS holder from leaving (027), and 034
// then added MANAGE_ROLES *alongside* it — 038 preserves both. The JS
// half of that same floor only ever re-implemented the second one.
//
// So the exact lockout 027 exists to prevent was still fully reachable,
// just through a different door: strip MANAGE_WORKSPACE_SETTINGS from
// the only role that carries it (Settings → Team → Roles → Edit), and
// trg_role_permissions_propagate (001) zeroes it out for every holder
// the instant it saves. Nothing objected, because this function wasn't
// looking for it.
//
// And it is permanent. permissionsBeyondCeiling enforces "you can only
// grant a permission you already hold" — with zero holders workspace-
// wide, no role edit and no member override can ever put it back.
// Permanently lost: Settings → Workspace, Branding, Defaults, Guardian,
// Danger zone, Approval workflows, workspace deletion and ownership
// transfer. Same unrecoverable shape as the APPROVE_DOCUMENTS seeding
// gap (migration 054), reached from the opposite direction.
//
// Expressed as a list rather than a second hardcoded key so the next
// permission that turns out to be self-gating can be added in one place
// instead of a fourth copy of this logic.
// FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM, see migration
// 071): the two permissions above are not the only ones with this
// unrecoverable-orphan shape. MANAGE_BILLING (nobody could ever pay,
// upgrade, or downgrade the plan again), INVITE_MEMBERS (nobody could grow
// the team, and nobody could grant INVITE_MEMBERS back to fix that), and
// VIEW_AUDIT_LOG (nobody could review the workspace's own audit trail, and
// — same shape again — nobody could re-grant that either) are all seeded
// onto every workspace's Owner role at creation, exactly like the two
// already here, so a real workspace always starts with a holder and the
// only way to reach zero is a role edit or override that strips the last
// one. (APPROVE_DOCUMENTS deliberately stays out of this list — see
// approvalPermissionOrphanedBy's own comment below for why a workspace can
// legitimately have zero holders of it, which isn't true of any of these.)
// SQL mirrors: update_role_permissions_atomic, update_member_permissions_atomic
// and leave_workspace_atomic (migration 071) all check the same five now.
export const PROTECTED_PERMISSIONS = ['MANAGE_ROLES', 'MANAGE_WORKSPACE_SETTINGS', 'MANAGE_BILLING', 'INVITE_MEMBERS', 'VIEW_AUDIT_LOG'] as const
export type ProtectedPermission = typeof PROTECTED_PERMISSIONS[number]

// `simulated` maps member id -> their post-change effective_permissions,
// for whichever member(s) the caller's change actually affects. Every
// active member NOT in that map keeps their current effective_permissions
// (the change doesn't touch them). Returns the protected permissions that
// would have ZERO active holders once the change lands — i.e. exactly
// what the caller must refuse to do. Empty array = safe to proceed.
export function protectedPermissionsOrphanedBy(
  activeMembers: ActiveMemberSnapshot[],
  simulated: Map<string, Record<string, unknown> | null>
): ProtectedPermission[] {
  return PROTECTED_PERMISSIONS.filter(permission =>
    !activeMembers.some(m => {
      const perms = simulated.has(m.id) ? simulated.get(m.id) : m.effectivePermissions
      return perms?.[permission] === true
    })
  )
}

// Kept as a thin wrapper so existing call sites keep compiling and keep
// meaning what they always meant. New code should prefer
// protectedPermissionsOrphanedBy, which can name WHICH permission is
// about to be orphaned in the error message.
export function wouldOrphanManageRoles(
  activeMembers: ActiveMemberSnapshot[],
  simulated: Map<string, Record<string, unknown> | null>
): boolean {
  return protectedPermissionsOrphanedBy(activeMembers, simulated).includes('MANAGE_ROLES')
}

// Human-readable label for an error message, so the UI says
// "no one who can manage workspace settings" rather than echoing a
// permission constant at the person.
export function describeProtectedPermission(permission: ProtectedPermission): string {
  switch (permission) {
    case 'MANAGE_ROLES': return 'manage roles'
    case 'MANAGE_WORKSPACE_SETTINGS': return 'manage workspace settings'
    case 'MANAGE_BILLING': return 'manage billing'
    case 'INVITE_MEMBERS': return 'invite members'
    case 'VIEW_AUDIT_LOG': return 'view the audit log'
    default: return permission
  }
}

// FIX (section-11 audit, pass 2): APPROVE_DOCUMENTS is a permission nobody can
// re-grant once it has no holder (the permission ceiling only lets you grant
// what you hold) — exactly the unrecoverable shape PROTECTED_PERMISSIONS
// exists for. Any admin editing a role could strip it from every role,
// including their own, and the whole approvals engine went dark for good: no
// approver could ever be assigned again and every pending request became
// undecidable.
//
// It is deliberately NOT added to PROTECTED_PERMISSIONS: the SQL functions that
// mirror that list (update_role_permissions_atomic, update_member_permissions_
// atomic, leave_workspace_atomic) check EVERY protected permission on any edit,
// so adding it there would make routine role edits fail in a workspace where
// nobody has been granted APPROVE_DOCUMENTS yet. This is the application-layer
// guard only — it applies to the edit that would remove the LAST holder, and
// says nothing about a workspace that never had one.
export function approvalPermissionOrphanedBy(
  activeMembers: ActiveMemberSnapshot[],
  simulated: Map<string, Record<string, unknown> | null>
): boolean {
  return !activeMembers.some(m => {
    const perms = simulated.has(m.id) ? simulated.get(m.id) : m.effectivePermissions
    return perms?.['APPROVE_DOCUMENTS'] === true
  })
}

export const APPROVE_DOCUMENTS_ORPHAN_MESSAGE =
  'This would leave the workspace with no one who can approve documents, and the approvals engine could never be used again — once nobody holds Approve documents, nobody can grant it back. Give it to another member or role first.'
