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
  const held = grantedKeys(inviter.effective_permissions)
  if (!held.includes('INVITE_MEMBERS')) return false

  let rolePerms: unknown = null
  if (roleId) {
    const { data } = await service.from('roles').select('permissions').eq('id', roleId).eq('workspace_id', workspaceId).maybeSingle()
    rolePerms = data?.permissions ?? null
  } else {
    const { data } = await service.from('roles').select('permissions').eq('workspace_id', workspaceId).eq('is_default', true).maybeSingle()
    rolePerms = data?.permissions ?? null
  }
  if (!rolePerms) return true
  return roleWithinCeiling({ permissions: held } as any, { permissions: rolePerms as Record<string, unknown> })
}
