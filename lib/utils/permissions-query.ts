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

// Notification preferences — defaults to enabled (true) when no row exists,
// since notification_preferences only stores explicit opt-outs/overrides,
// not a row per user per event type by default.
export async function filterByNotificationPreference<T extends { id: string }>(
  service: any,
  workspaceId: string,
  eventType: string,
  recipients: T[]
): Promise<T[]> {
  if (recipients.length === 0) return recipients
  const { data: prefs } = await service
    .from('notification_preferences')
    .select('user_id, email_enabled')
    .eq('workspace_id', workspaceId)
    .eq('event_type', eventType)
    .in('user_id', recipients.map(r => r.id))

  const disabled = new Set((prefs || []).filter((p: any) => p.email_enabled === false).map((p: any) => p.user_id))
  return recipients.filter(r => !disabled.has(r.id))
}

// Approval steps can name a specific role rather than a permission — every
// active member holding that role is a valid approver for the step (any one
// of them can act on it). Same ambiguous-FK and JS-side-filter caveats as
// getMembersWithPermission above apply here.
export async function getMembersWithRole(
  service: any,
  workspaceId: string,
  roleId: string,
  limit = 25
): Promise<Array<{ id: string; name: string; email: string }>> {
  const { data: members } = await service
    .from('workspace_members')
    .select('role_id, users!workspace_members_user_id_fkey(id, name, email)')
    .eq('workspace_id', workspaceId)
    .eq('role_id', roleId)
    .eq('status', 'active')
    .limit(limit)

  return (members || [])
    .filter((m: any) => m.users?.email)
    .map((m: any) => ({ id: m.users.id, name: m.users.name, email: m.users.email }))
}

export async function getMemberEmailsWithPermission(
  service: any,
  workspaceId: string,
  permission: Permission,
  limit = 25,
  eventType?: string
): Promise<string[]> {
  let members = await getMembersWithPermission(service, workspaceId, permission, limit)
  if (eventType) members = await filterByNotificationPreference(service, workspaceId, eventType, members)
  return members.map(m => m.email)
}
