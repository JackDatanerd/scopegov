// lib/utils/notify.ts
//
// Creates in-app notification rows (public.notifications). Previously
// nothing in the codebase ever inserted into this table — it was fully
// scaffolded (schema, GET/PATCH API) but completely disconnected from the
// actual event pipeline. This is the single choke point for creating them,
// mirroring the same permission + preference filtering already used for
// email recipients (getMembersWithPermission / filterByNotificationPreference)
// so the two stay consistent.

import { getMembersWithPermission, filterByNotificationPreference } from './permissions-query'
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
}

export async function notifyMembersWithPermission(service: any, params: NotifyParams) {
  try {
    let recipients = await getMembersWithPermission(service, params.workspaceId, params.permission, 25)
    recipients = await filterByNotificationPreference(service, params.workspaceId, params.eventType, recipients)
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
    }))
    await service.from('notifications').insert(rows)
  } catch {
    // Never let a notification failure break the actual action it's attached to.
  }
}
