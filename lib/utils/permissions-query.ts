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

export async function filterToProjectAccess<T extends { id: string }>(
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

// Notification preferences — defaults to enabled (true) when no row exists
// and no workspace default overrides it, since notification_preferences
// only stores explicit opt-outs/overrides, not a row per user per event
// type by default.
//
// FIX (re-audit, notifications section): `channel` used to be implicit —
// this always read `email_enabled`, so any caller building an in-app
// recipient list (notifyMembersWithPermission) was actually filtering on
// the user's EMAIL preference. The two columns are independent by design
// (see notification_preferences schema and the Settings UI, which only
// ever writes/exposes email_enabled while in_app_enabled stays true) — an
// event.the user muted by email should still show up in their bell.
//
// FIX (deep audit, notifications section — flagship finding): this is the
// single choke point every notification path routes through, so it's the
// one place that needed to start reading `workspace_notification_defaults`
// — a table with a full schema (including a `locked` column), RLS
// policies, and rows seeded across three separate migrations every time a
// new event type shipped (004, 007, 009), but never once read by any
// application code; migration 007's own comment says so outright. Two
// things a workspace admin had no way to do as a result: set a sane
// opt-in/opt-out default for new members on a given event, or make a
// notification mandatory (e.g. guardian_flag, invoice_payment_received)
// so an individual member's preference can't silently suppress it. Both
// now work: an unlocked default changes what "no row exists" resolves to
// for that event/channel; a locked default is authoritative and skips the
// per-user lookup entirely — nothing after this point can override it.
export async function filterByNotificationPreference<T extends { id: string }>(
  service: any,
  workspaceId: string,
  eventType: string,
  recipients: T[],
  channel: 'email' | 'in_app' = 'email'
): Promise<T[]> {
  if (recipients.length === 0) return recipients
  const column = channel === 'in_app' ? 'in_app_enabled' : 'email_enabled'

  const { data: workspaceDefault } = await service
    .from('workspace_notification_defaults')
    .select(`${column}, locked`)
    .eq('workspace_id', workspaceId)
    .eq('event_type', eventType)
    .maybeSingle()

  // A locked default is mandatory workspace-wide — no member can override
  // it, so there's no need to even look at notification_preferences.
  if (workspaceDefault?.locked) {
    return workspaceDefault[column] ? recipients : []
  }

  const orgDefault = workspaceDefault ? workspaceDefault[column] : true

  const { data: prefs } = await service
    .from('notification_preferences')
    .select(`user_id, ${column}`)
    .eq('workspace_id', workspaceId)
    .eq('event_type', eventType)
    .in('user_id', recipients.map(r => r.id))

  const overrides = new Map<string, boolean>((prefs || []).map((p: any) => [p.user_id, p[column]]))
  return recipients.filter(r => (overrides.has(r.id) ? overrides.get(r.id) : orgDefault) !== false)
}

// Approval steps can name a specific role rather than a permission — every
// active member holding that role is a valid approver for the step (any one
// of them can act on it). Same ambiguous-FK and JS-side-filter caveats as
// getMembersWithPermission above apply here.
//
// FIX (deep audit, RLS+permissions re-pass): this never got the project-
// visibility filter getMembersWithPermission received in "audit round 4,
// finding #8" above, despite the same rule applying — a role-based
// approval step (e.g. "whoever holds Finance Reviewer") assigned to a
// role that carries VIEW_OWN_PROJECTS (not VIEW_ALL_PROJECTS) notified
// EVERY active member holding that role, including ones never assigned
// to the specific project the document belongs to, with its title/
// project name/amount in the email and in-app notification body — for a
// document those members would get a 403 trying to actually open.
// `projectId` is optional and behaves exactly like the sibling function:
// pass it whenever the event being notified about belongs to a specific
// project. Needs each recipient's effective_permissions to check
// VIEW_ALL_PROJECTS the same way filterToProjectAccess already does for
// getMembersWithPermission — fetched here for that purpose only, not
// otherwise used or returned.
export async function getMembersWithRole(
  service: any,
  workspaceId: string,
  roleId: string,
  limit = 25,
  projectId?: string,
  // FIX (deep audit, notifications+search section): this function never
  // got the other half of the fix its own comment above describes for
  // project-visibility ("deep audit, RLS+permissions re-pass") — it still
  // sliced to `limit` on its own, before the caller (notifyStepApprovers)
  // applied filterByNotificationPreference to the result. Exactly the
  // "cap applied before the final filter" bug already fixed twice for the
  // sibling getMembersWithPermission (audit round 4 #8, cron audit #17):
  // in a workspace with more than `limit` active members holding an
  // approver role, an opted-out member could still consume a slot in the
  // pre-filter batch, silently excluding a legitimately opted-in approver
  // past the cutoff. Threading eventType/channel through, same as the
  // sibling function, so preference filtering happens before the slice.
  eventType?: string,
  channel: 'email' | 'in_app' = 'email'
): Promise<Array<{ id: string; name: string; email: string }>> {
  // FIX (deep audit, RLS+permissions re-pass): this reintroduced the exact
  // "cap applied before the final filter" bug already fixed for the
  // sibling getMembersWithPermission above (see "audit round 4, finding
  // #8" and "cron audit, section 17") — `.limit(limit)` ran on the raw
  // role-membership query, BEFORE filterToProjectAccess() below could
  // remove anyone not assigned to this project, and with no `.order()`
  // for determinism either. In a workspace with more than `limit` active
  // members holding this role, a legitimately project-assigned approver
  // could be silently excluded from ever being notified their approval is
  // needed, simply for not landing in the first, arbitrarily-ordered
  // batch Postgres returned — while members who get filtered out right
  // afterward for lacking project access had already consumed a slot in
  // that batch. Same fix shape: fetch a generous, ordered upper bound,
  // filter, THEN slice to `limit`.
  const { data: members } = await service
    .from('workspace_members')
    .select('user_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
    .eq('workspace_id', workspaceId)
    .eq('role_id', roleId)
    .eq('status', 'active')
    .order('user_id')
    .limit(500)

  const eligible = (members || []).filter((m: any) => m.users?.email)
  // FIX (fix round, section-11 finding): confirmed via independent trace —
  // this used to return every active member holding the role regardless
  // of whether the role still actually carries APPROVE_DOCUMENTS. A role
  // can be validated to have it at workflow-creation time, then later
  // have it stripped via the "warn, don't block" edit path (see
  // app/api/team/roles/[id]/route.ts and app/api/team/[id]/route.ts,
  // whose own comments already documented this exact gap: those members
  // stay "reachable" here, so the stall cron's zero-recipients escalation
  // never fires and the step just silently can never be decided). Filter
  // on effective_permissions directly rather than a separate roles-table
  // lookup — migration 001's trigger keeps it synchronously in sync with
  // the role's own permissions for every member holding it, so this is
  // already the live value, not a stale snapshot.
  const approvers = eligible.filter((m: any) => m.effective_permissions?.['APPROVE_DOCUMENTS'] === true)
  const permissionMap = new Map<string, Record<string, boolean>>(
    approvers.map((m: any) => [m.user_id, m.effective_permissions || {}])
  )
  let recipients = approvers.map((m: any) => ({ id: m.users.id, name: m.users.name, email: m.users.email }))

  if (projectId) recipients = await filterToProjectAccess(service, projectId, recipients, permissionMap)
  if (eventType) recipients = await filterByNotificationPreference(service, workspaceId, eventType, recipients, channel)

  return recipients.slice(0, limit)
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
