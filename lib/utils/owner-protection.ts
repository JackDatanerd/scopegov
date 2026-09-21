// lib/utils/owner-protection.ts
//
// The workspace OWNER (workspaces.created_by) can only be acted on by themselves:
// nobody else may deactivate them or change their role / permission overrides,
// however many permissions the actor holds. Until audit round 2 this held only by
// accident — the Owner role carried a stale `EXPORT_DATA` key that no other
// role could ever hold, so the "an actor may only act on someone whose
// permissions are a subset of their own" rule happened to exclude an
// all-permissions admin. Removing that dead key (migration 068) would have
// silently handed every peer admin the ability to remove the Owner, so the
// protection is now explicit. Ownership changes hands only through
// /api/workspace/transfer-ownership.

export const OWNER_PROTECTED_MESSAGE =
  'This person is the workspace owner, so their access can\u2019t be changed by anyone else. They can hand ownership over from Settings \u2192 Danger zone first.'

export async function workspaceOwnerId(service: any, workspaceId: string): Promise<string | null> {
  const { data } = await service.from('workspaces').select('created_by').eq('id', workspaceId).maybeSingle()
  return (data?.created_by as string | undefined) ?? null
}

/** True when `targetUserId` is the workspace owner and someone OTHER than them is acting. */
export async function isProtectedOwnerTarget(
  service: any, workspaceId: string, actorUserId: string, targetUserId: string | null | undefined
): Promise<boolean> {
  if (!targetUserId || targetUserId === actorUserId) return false
  return (await workspaceOwnerId(service, workspaceId)) === targetUserId
}
