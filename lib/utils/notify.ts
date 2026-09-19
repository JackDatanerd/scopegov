// lib/utils/notify.ts
//
// Creates in-app notification rows (public.notifications). Previously
// nothing in the codebase ever inserted into this table — it was fully
// scaffolded (schema, GET/PATCH API) but completely disconnected from the
// actual event pipeline. This is the single choke point for creating them,
// mirroring the same permission + preference filtering already used for
// email recipients (getMembersWithPermission / filterByNotificationPreference)
// so the two stay consistent.

import { getMembersWithPermission } from './permissions-query'
import type { Permission } from '@/lib/supabase/types'

interface NotifyParams {
  workspaceId: string
  permission:  Permission
  eventType:   string
  type:        string
  title:       string
  body:        string
  entityType?: string
  entityId?:   string
  excludeUserId?: string  // don't notify the person who triggered their own action
  // FIX (audit round 4, finding #8): pass the entity's project when the
  // event is project-scoped (guardian flag, invoice, CO/SOW) so recipients
  // are additionally filtered to VIEW_ALL_PROJECTS holders or actual
  // members of that project — see lib/utils/permissions-query.ts.
  projectId?: string
}

export async function notifyMembersWithPermission(service: any, params: NotifyParams) {
  try {
    // FIX (cron audit, section 17): eventType now passed into
    // getMembersWithPermission itself so the notification-preference
    // filter runs before the limit-25 slice, not after — see the fix note
    // on that function. Filtering here, one layer up and after the slice
    // already happened, could silently under-notify a workspace with more
    // eligible members than the cap.
    //
    // FIX (re-audit, notifications section): this is the single choke
    // point for creating in-app rows (see file header), so it must filter
    // on `in_app_enabled`, not the default `email_enabled` — otherwise
    // muting EMAIL for an event (the only toggle Settings exposes) also
    // silently suppresses the bell notification for it. Email delivery for
    // the same event is a separate call elsewhere (getMemberEmailsWithPermission,
    // channel defaults to 'email') — the two are independent by design.
    let recipients = await getMembersWithPermission(
      service, params.workspaceId, params.permission, 25, params.projectId, params.eventType, 'in_app'
    )
    if (params.excludeUserId) recipients = recipients.filter(r => r.id !== params.excludeUserId)
    if (recipients.length === 0) return

    const rows = recipients.map(r => ({
      workspace_id: params.workspaceId,
      recipient_id: r.id,
      type:         params.type,
      title:        params.title,
      body:         params.body,
      entity_type:  params.entityType || null,
      entity_id:    params.entityId || null,
      // FIX (re-audit, notifications section): needed so entity_type
      // values that aren't 'project' itself (flag/exception comments, most
      // notably) can still be deep-linked from the bell — see migration
      // 028 and NotificationBell.tsx's entityHref().
      project_id:   params.projectId || null,
    }))
    // FIX (deep audit round 3, notifications section): supabase-js does
    // not throw on a DB-level insert error (bad FK, constraint violation,
    // etc.) — it returns { error } — so this previously ran unchecked and
    // any such failure vanished into this catch's silent `{}` with zero
    // trace anywhere, not even a console.error. This is the exact same
    // failure shape that let 12 audit_log rows silently disappear for
    // months (round 13's flagship finding, lib/utils/audit.ts) before
    // being caught by accident. Checking + logging here doesn't change
    // behavior when things work, but means a future bad-data bug in this
    // choke point leaves a trace instead of repeating that history.
    const { error } = await service.from('notifications').insert(rows)
    if (error) console.error('notifyMembersWithPermission: notifications insert failed:', error)
  } catch (err) {
    console.error('notifyMembersWithPermission failed:', err)
  }
}
