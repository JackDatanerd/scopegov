// lib/utils/invite-authority.ts
//
// An invite is the inviter's act of GRANTING a role, and the grant is only as good
// as the inviter's authority at the moment the invite is USED — not when it was
// typed. Invites used to stay valid for their full 7 days after the person who sent
// them was deactivated, left, or was demoted below the role they had offered (and
// "Resend" refreshed them). This is checked when an invite is accepted.

import { roleWithinCeiling } from '@/lib/utils/permission-ceiling'

function grantedKeys(map: unknown): string[] {
  if (!map || typeof map !== 'object') return []
  return Object.entries(map as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k)
}

/**
 * True when the person who sent the invite is still an ACTIVE member who holds
 * INVITE_MEMBERS and every permission of the role being handed out. An invite with
 * no recorded inviter (very old rows) can't be checked and is allowed.
 */
export async function inviterMayStillGrant(
  service: any, workspaceId: string, invitedBy: string | null | undefined, roleId: string | null | undefined
): Promise<boolean> {
  if (!invitedBy) return true
  const { data: inviter } = await service
    .from('workspace_members').select('effective_permissions')
    .eq('workspace_id', workspaceId).eq('user_id', invitedBy).eq('status', 'active').maybeSingle()
  if (!inviter) return false

  let rolePerms: unknown = null
  if (roleId) {
    const { data } = await service.from('roles').select('permissions').eq('id', roleId).eq('workspace_id', workspaceId).maybeSingle()
    rolePerms = data?.permissions ?? null
  } else {
    const { data } = await service.from('roles').select('permissions').eq('workspace_id', workspaceId).eq('is_default', true).maybeSingle()
    rolePerms = data?.permissions ?? null
  }
  return inviterGrantAllowed(inviter.effective_permissions, rolePerms)
}

/**
 * The pure half of inviterMayStillGrant, for callers that already hold the data (the Team page
 * flags pending invites whose sender has since lost the authority to grant them, without an
 * extra query per row). `inviterPerms` is the inviter's effective_permissions, or null/undefined
 * when they are no longer an active member. A role with no permission map (deleted / not found)
 * can't be checked and is allowed, exactly as before.
 */
export function inviterGrantAllowed(inviterPerms: unknown, rolePerms: unknown): boolean {
  if (!inviterPerms) return false
  const held = grantedKeys(inviterPerms)
  if (!held.includes('INVITE_MEMBERS')) return false
  if (!rolePerms) return true
  return roleWithinCeiling({ permissions: held } as any, { permissions: rolePerms as Record<string, unknown> })
}

/**
 * The role an invite will actually hand out when it is accepted: its own `role_id`, or — for an invite
 * with no role recorded — the workspace's default role (that is exactly what the accept and signup
 * routes assign, and what inviterMayStillGrant checks the inviter against). Callers that gate an
 * action on "the role this invite grants must sit within the actor's own permissions" must check THIS
 * role, not merely `member.roles`: a null role_id used to skip the ceiling entirely, so an admin could
 * re-attribute (or clear the role of) an invite whose implicit default role they could never have
 * issued, leaving it a guaranteed 410 dead end for the invitee. Null when there is no such role.
 */
export async function roleGrantedAtAcceptance(
  service: any, workspaceId: string, roleId: string | null | undefined
): Promise<{ id: string; name: string; permissions: Record<string, unknown> } | null> {
  const base = service.from('roles').select('id,name,permissions').eq('workspace_id', workspaceId)
  const { data } = roleId
    ? await base.eq('id', roleId).maybeSingle()
    : await base.eq('is_default', true).maybeSingle()
  return data ?? null
}
