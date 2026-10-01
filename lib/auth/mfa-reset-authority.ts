// lib/auth/mfa-reset-authority.ts
//
// FIX (Auth+MFA pass 9 — MEDIUM): MFA belongs to the PERSON, not to a workspace. POST
// /api/team/[id]/reset-mfa removes the target's authenticator and signs them out of EVERY session, but
// its permission ceiling and owner protection were evaluated against the actor's workspace only. A
// freelancer who is a plain member of agency A and Owner of their own agency B could therefore have
// the second factor guarding B stripped by any MANAGE_ROLES holder of A. Resetting is now allowed only
// when the actor also holds authority over EVERY OTHER workspace the target is active in: MANAGE_ROLES
// there, the target's permissions there within the actor's own, and the target not that workspace's
// owner. Anyone else is pointed at the person's own backup-code recovery or platform support.

import { activeWorkspaceIdsForUser } from '@/lib/auth/security-audit'
import { workspaceOwnerId } from '@/lib/utils/owner-protection'

// Same rule as lib/utils/permission-ceiling.ts, over raw permission maps: anything the target holds
// (not false/null/undefined) must be a permission the actor holds as a real JSON `true`.
function permissionsBeyondCeiling(actorPerms: Record<string, unknown>, target: Record<string, unknown> | null): string[] {
  if (!target) return []
  return Object.keys(target).filter(k => {
    const v = target[k]
    return v !== false && v !== null && v !== undefined && actorPerms[k] !== true
  })
}

export const MFA_RESET_OTHER_WORKSPACE_MESSAGE =
  'This person is also a member of another workspace you don\u2019t manage, and two-factor authentication protects their access to it too. They can recover with a backup code, or contact ScopeGov support.'

export function mfaResetAuthorityGaps(args: {
  otherWorkspaceIds: string[]
  actorMemberships: Array<{ workspace_id: string; effective_permissions: Record<string, unknown> | null }>
  targetMemberships: Array<{ workspace_id: string; effective_permissions: Record<string, unknown> | null }>
  ownerByWorkspace: Record<string, string | null>
  targetUserId: string
}): string[] {
  const gaps: string[] = []
  for (const wid of args.otherWorkspaceIds) {
    const actor = args.actorMemberships.find(m => m.workspace_id === wid)
    const target = args.targetMemberships.find(m => m.workspace_id === wid)
    const perms = actor?.effective_permissions || null
    if (!actor || !perms || perms['MANAGE_ROLES'] !== true) { gaps.push(wid); continue }
    if (args.ownerByWorkspace[wid] === args.targetUserId) { gaps.push(wid); continue }
    if (permissionsBeyondCeiling(perms, target?.effective_permissions || null).length > 0) gaps.push(wid)
  }
  return gaps
}

/** Workspaces (other than `currentWorkspaceId`) where the actor lacks the authority described above. */
export async function otherWorkspaceResetGaps(
  service: any, actorUserId: string, targetUserId: string, currentWorkspaceId: string
): Promise<string[]> {
  const others = (await activeWorkspaceIdsForUser(service, targetUserId)).filter(w => w !== currentWorkspaceId)
  if (others.length === 0) return []
  const { data: both } = await service.from('workspace_members')
    .select('workspace_id, user_id, effective_permissions')
    .in('user_id', [actorUserId, targetUserId]).in('workspace_id', others).eq('status', 'active')
  const rows = (both || []) as Array<{ workspace_id: string; user_id: string; effective_permissions: any }>
  const ownerByWorkspace: Record<string, string | null> = {}
  for (const w of others) ownerByWorkspace[w] = await workspaceOwnerId(service, w)
  return mfaResetAuthorityGaps({
    otherWorkspaceIds: others,
    actorMemberships: rows.filter(r => r.user_id === actorUserId),
    targetMemberships: rows.filter(r => r.user_id === targetUserId),
    ownerByWorkspace, targetUserId,
  })
}
