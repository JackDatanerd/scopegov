// lib/utils/role-holders.ts
//
// FIX (deep audit, Team & Invites independent re-pass — bug): the Roles
// tab in components/team/TeamClient.tsx used to count only active members
// (`members.filter(m => m.role_id === r.id).length`) for both its
// "Members" column and whether the Delete-role button looked safe to
// click. DELETE /api/team/roles/[id] actually refuses a role held by ANY
// active, pending/expired invite, OR deactivated member — three
// categories the component already received as props but never
// consulted here. A role could show "0 Members" with a plain "Delete
// role" tooltip while pending invites or deactivated members still held
// it, so clicking Delete did nothing but surface a 409 the UI gave no
// warning of. Extracted to a pure function (rather than left inline in
// the component) so it's covered the same way the rest of this repo's
// logic is — by a plain unit test — since there's no React component-
// test setup here to render TeamClient itself against.
export interface RoleHolderCounts {
  active: number
  pending: number
  deactivated: number
  total: number
}

export function roleHolderCounts(
  roleId: string,
  lists: {
    members?: Array<{ role_id: string | null }> | null
    pendingInvites?: Array<{ role_id: string | null }> | null
    expiredInvites?: Array<{ role_id: string | null }> | null
    deactivatedMembers?: Array<{ role_id: string | null }> | null
  }
): RoleHolderCounts {
  const countIn = (list: Array<{ role_id: string | null }> | null | undefined) =>
    (list || []).filter(m => m.role_id === roleId).length

  const active      = countIn(lists.members)
  const pending      = countIn(lists.pendingInvites) + countIn(lists.expiredInvites)
  const deactivated = countIn(lists.deactivatedMembers)
  return { active, pending, deactivated, total: active + pending + deactivated }
}
