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
//
// FIX (audit round 4, finding #8): these lookups were purely permission-
// based, with no awareness of per-project visibility at all. A workspace
// member holding e.g. APPROVE_FLAGS but restricted to VIEW_OWN_PROJECTS
// (not VIEW_ALL_PROJECTS) would still receive email/in-app notifications
// — including financial amounts and document titles — for guardian flags,
// invoices, and CO/SOW events on projects they have no access to and
// would get a 403 trying to open directly. Same rule as
// lib/utils/project-access.ts's canReadProject, now optionally applied
// here too via the `projectId` parameter — pass it whenever the event
// being notified about belongs to a specific project.

import type { Permission } from '@/lib/supabase/types'

async function filterToProjectAccess<T extends { id: string }>(
  service: any, projectId: string, recipients: T[], permissionMap: Map<string, Record<string, boolean>>
): Promise<T[]> {
  if (recipients.length === 0) return recipients

  const viewAllIds = new Set(
    recipients.filter(r => permissionMap.get(r.id)?.VIEW_ALL_PROJECTS === true).map(r => r.id)
  )
  const remaining = recipients.filter(r => !viewAllIds.has(r.id))
  let projectMemberIds = new Set<string>()
  if (remaining.length) {
    const { data } = await service
      .from('project_members')
      .select('workspace_members!inner(user_id)')
      .eq('project_id', projectId)
    projectMemberIds = new Set((data || []).map((r: any) => r.workspace_members.user_id))
  }
  return recipients.filter(r => viewAllIds.has(r.id) || projectMemberIds.has(r.id))
}

export async function getMembersWithPermission(
  service: any,
  workspaceId: string,
  permission: Permission,
  limit = 25,
  projectId?: string,
  // FIX (cron audit, section 17): the same "cap applied before the final
  // filter" bug this function's own comment below describes fixing — for
  // the permission check — was still present one layer up: both callers
  // (getMemberEmailsWithPermission and notifyMembersWithPermission)
  // applied filterByNotificationPreference AFTER calling this function,
  // which had already sliced to `limit`. In a workspace with more eligible
  // members than `limit`, an opted-out member still consumed a slot in
  // that slice — so an opted-in member past the cutoff never got notified
  // even though room existed once the opt-out was accounted for. Accepting
  // eventType here lets preference filtering happen before the slice,
  // same as project-access filtering already does.
  eventType?: string,
  // FIX (re-audit, notifications section): this was hardcoded to check
  // `email_enabled` regardless of which channel the caller actually cares
  // about. notifyMembersWithPermission (lib/utils/notify.ts) — the single
  // choke point for creating in-app bell rows — called this same function
  // for its recipient list, so opting out of EMAIL for an event (the only
  // toggle Settings exposes, literally labelled "Email notifications")
  // silently also removed the recipient from the in-app notification for
  // that same event, even though `in_app_enabled` is a distinct column
  // that the preferences route always writes as `true`. Now threaded
  // through so each caller filters on the column it's actually delivering
  // through — see filterByNotificationPreference below.
  channel: 'email' | 'in_app' = 'email'
): Promise<Array<{ id: string; name: string; email: string }>> {
  // FIX (re-audit, notifications section): `.limit(limit)` used to be
  // applied to the raw active-members query, BEFORE the permission filter
  // below — so in any workspace with more than `limit` active members,
  // whoever happened to land outside that first arbitrary (unordered —
  // there was no .order() either) batch was silently excluded from ever
  // receiving this notification, regardless of whether they actually held
  // the permission. The cap needs to apply to the *eligible* set, after
  // filtering, not to the pool it's filtered from. Ordering added for
  // determinism; a generous upper bound (10x the largest limit any caller
  // passes today) keeps this from becoming an unbounded query on a very
  // large workspace while not truncating realistic team sizes.
  const { data: members } = await service
    .from('workspace_members')
    .select('user_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .order('user_id')
    .limit(500)

  const eligible = (members || [])
    .filter((m: any) => m.effective_permissions?.[permission] === true && m.users?.email)

  const permissionMap = new Map<string, Record<string, boolean>>(
    eligible.map((m: any) => [m.user_id, m.effective_permissions])
  )
  let recipients = eligible.map((m: any) => ({ id: m.user_id, name: m.users.name, email: m.users.email }))

  if (projectId) recipients = await filterToProjectAccess(service, projectId, recipients, permissionMap)
  if (eventType) recipients = await filterByNotificationPreference(service, workspaceId, eventType, recipients, channel)

  return recipients.slice(0, limit)
}

// Notification preferences — defaults to enabled (true) when no row exists,
// since notification_preferences only stores explicit opt-outs/overrides,
// not a row per user per event type by default.
//
// FIX (re-audit, notifications section): `channel` used to be implicit —
// this always read `email_enabled`, so any caller building an in-app
// recipient list (notifyMembersWithPermission) was actually filtering on
// the user's EMAIL preference. The two columns are independent by design
// (see notification_preferences schema and the Settings UI, which only
// ever writes/exposes email_enabled while in_app_enabled stays true) — an
// event.the user muted by email should still show up in their bell.
export async function filterByNotificationPreference<T extends { id: string }>(
  service: any,
  workspaceId: string,
  eventType: string,
  recipients: T[],
  channel: 'email' | 'in_app' = 'email'
): Promise<T[]> {
  if (recipients.length === 0) return recipients
  const column = channel === 'in_app' ? 'in_app_enabled' : 'email_enabled'
  const { data: prefs } = await service
    .from('notification_preferences')
    .select(`user_id, ${column}`)
    .eq('workspace_id', workspaceId)
    .eq('event_type', eventType)
    .in('user_id', recipients.map(r => r.id))

  const disabled = new Set((prefs || []).filter((p: any) => p[column] === false).map((p: any) => p.user_id))
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
  eventType?: string,
  projectId?: string
): Promise<string[]> {
  // FIX (cron audit, section 17): eventType now passed straight into
  // getMembersWithPermission so preference filtering happens before the
  // limit slice, not after it — see the fix note on that function.
  const members = await getMembersWithPermission(service, workspaceId, permission, limit, projectId, eventType)
  return members.map(m => m.email)
}
