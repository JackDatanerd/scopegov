// lib/utils/permissions-query.ts
// Centralizes the "find members who can do X" lookup used for notification
// recipients. Two bugs this fixes by design:
//
// 1. workspace_members has TWO foreign keys to users (user_id, invited_by).
//    Any unqualified `users(...)` embed is ambiguous in PostgREST and throws
//    at runtime. We always qualify with `users!workspace_members_user_id_fkey`.
//
// 2. `.filter('effective_permissions->KEY', 'eq', 'true')` relies on how
//    Postgres compares a jsonb value to the string 'true', which is fragile
//    and unverified against this schema. Instead we fetch active members'
//    effective_permissions and filter in JS, which works regardless of how
//    the boolean was stored.

import type { Permission } from '@/lib/supabase/types'

export async function getMembersWithPermission(
  service: any,
  workspaceId: string,
  permission: Permission,
  limit = 25
): Promise<Array<{ id: string; name: string; email: string }>> {
  const { data: members } = await service
    .from('workspace_members')
    .select('effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .limit(limit)

  return (members || [])
    .filter((m: any) => m.effective_permissions?.[permission] === true && m.users?.email)
    .map((m: any) => ({ id: m.users.id, name: m.users.name, email: m.users.email }))
}

export async function getMemberEmailsWithPermission(
  service: any,
  workspaceId: string,
  permission: Permission,
  limit = 25
): Promise<string[]> {
  const members = await getMembersWithPermission(service, workspaceId, permission, limit)
  return members.map(m => m.email)
}
