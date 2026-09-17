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

// `simulated` maps member id -> their post-change effective_permissions,
// for whichever member(s) the caller's change actually affects. Every
// active member NOT in that map keeps their current effective_permissions
// (the change doesn't touch them). Returns true if NO active member would
// hold MANAGE_ROLES once the change lands — i.e. the change must be
// blocked.
export function wouldOrphanManageRoles(
  activeMembers: ActiveMemberSnapshot[],
  simulated: Map<string, Record<string, unknown> | null>
): boolean {
  return !activeMembers.some(m => {
    const perms = simulated.has(m.id) ? simulated.get(m.id) : m.effectivePermissions
    return perms?.['MANAGE_ROLES'] === true
  })
}
