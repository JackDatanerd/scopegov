// lib/utils/notify.ts
//
// Creates in-app notification rows (public.notifications). Previously
// nothing in the codebase ever inserted into this table — it was fully
// scaffolded (schema, GET/PATCH API) but completely disconnected from the
// actual event pipeline. This is the single choke point for creating them,
// mirroring the same permission + preference filtering already used for
// email recipients (getMembersWithPermission / filterByNotificationPreference)
// so the two stay consistent.

import { getMembersWithPermission, filterToProjectAccess, filterByNotificationPreference } from './permissions-query'
import type { Permission } from '@/lib/supabase/types'
import { emitIntegrationEvent } from '@/lib/integrations/events'

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
  /**
   * Structured facts for integrations (webhooks / Zapier), merged into the event's `data`. Put a document reference in
   * `document: { type, id }` (types: sow | change_order | invoice | payment_milestone | guardian_flag) and the delivery
   * worker fills in its number, status, amounts and dates (lib/integrations/enrich.ts); add only facts the call site
   * already holds (who signed, the client's reason, the payment just recorded). Never put a secret or an email in here.
   * tests/integrations-payloads.test.ts fails for a mapped event whose call site omits this.
   */
  integrationData?: Record<string, unknown>
  /** Do not announce this to integrations (the in-app notification is unaffected). */
  skipIntegrations?: boolean
}

/** Resolves true when the rows were written (or there was nobody eligible to write them for); false on failure. */
export async function notifyMembersWithPermission(service: any, params: NotifyParams): Promise<boolean> {
  // Integrations (signed webhooks, and Zapier/Slack/HubSpot/Drive as they land) hear about the same business events the
  // bell does, from this one choke point. Announced BEFORE the recipient lookup so a workspace where nobody is eligible
  // for the in-app row (or everyone muted it) still tells its integrations. emitIntegrationEvent never throws and ignores
  // any event not on its allowlist; see lib/integrations/events.ts.
  if (params.eventType && !params.skipIntegrations) {
    await emitIntegrationEvent({
      workspaceId: params.workspaceId, eventKey: params.eventType,
      entityType: params.entityType, entityId: params.entityId, projectId: params.projectId,
      // title/summary last: a call site's structured facts can add fields but never rewrite what the bell says.
      data: { ...(params.integrationData || {}), title: params.title, summary: params.body },
    }, service)
  }
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
    // excludeUserId is applied inside getMembersWithPermission, before its
    // limit slice (it used to be filtered afterwards, shrinking the list).
    const recipients = await getMembersWithPermission(
      service, params.workspaceId, params.permission, 25, params.projectId, params.eventType, 'in_app', params.excludeUserId
    )
    if (recipients.length === 0) return true

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
    if (error) { console.error('notifyMembersWithPermission: notifications insert failed:', error); return false }
    return true
  } catch (err) {
    console.error('notifyMembersWithPermission failed:', err)
    return false
  }
}

// ── Direct-to-user notifications ─────────────────────────────────────────────
// FIX (Notifications & email fix round): nine call sites (flag/CO escalation,
// the approval engine ×3, comment-owner alerts, @mentions, the MFA security
// notices) each hand-rolled `service.from('notifications').insert(...)` inside
// a try/catch. supabase-js reports a failed insert by RETURNING `{ error }` —
// it does not throw — so none of them ever noticed a failure (the MFA rows,
// for one, carried a possibly-null workspace_id into a NOT NULL column and
// silently vanished). They also skipped the checks notifyMembersWithPermission
// applies: the recipient could be a deactivated member, someone with no access
// to the project named in the notification, or someone who had muted the event.
//
// notifyUsers() is the one path for "tell these specific people":
//   • only ACTIVE members of the workspace are eligible,
//   • when projectId is given, only people who can open that project,
//   • when eventType is given, in-app preferences (and locked defaults) apply,
//   • the insert's `{ error }` is actually read.
// It returns the eligible recipients so a caller that also emails can use the
// very same list — the two channels then can't disagree.

export interface NotifyUsersParams {
  workspaceId: string
  recipientIds: Array<string | null | undefined>
  type: string
  title: string
  body: string
  entityType?: string
  entityId?: string
  projectId?: string
  /** Applies the recipients' in-app preference for this event when set. */
  eventType?: string
  /** The person who caused the event — never notified about their own action. */
  excludeUserId?: string
}

export interface NotifyRecipient { id: string; name: string; email: string }

/** Checked insert of already-resolved notification rows. Returns false on failure. */
export async function insertNotificationRows(service: any, rows: Array<Record<string, unknown>>): Promise<boolean> {
  if (rows.length === 0) return true
  try {
    const { error } = await service.from('notifications').insert(rows)
    if (error) {
      console.error('[notifications] insert failed:', error.message || error)
      return false
    }
    return true
  } catch (err) {
    console.error('[notifications] insert threw:', err)
    return false
  }
}

export async function notifyUsers(service: any, params: NotifyUsersParams): Promise<{ recipients: NotifyRecipient[]; inserted: boolean }> {
  try {
    const ids = Array.from(new Set(params.recipientIds.filter((x): x is string => !!x)))
      .filter(id => id !== params.excludeUserId)
    if (ids.length === 0) return { recipients: [], inserted: true }

    const { data: members, error } = await service
      .from('workspace_members')
      .select('user_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
      .eq('workspace_id', params.workspaceId)
      .eq('status', 'active')
      .in('user_id', ids)
    if (error) throw new Error(error.message)

    const eligible = (members || []).filter((m: any) => m.users)
    const permissionMap = new Map<string, Record<string, boolean>>(
      eligible.map((m: any) => [m.user_id, m.effective_permissions || {}])
    )
    let recipients: NotifyRecipient[] = eligible.map((m: any) => ({ id: m.user_id, name: m.users.name, email: m.users.email }))

    if (params.projectId) recipients = await filterToProjectAccess(service, params.projectId, recipients, permissionMap)
    if (params.eventType) recipients = await filterByNotificationPreference(service, params.workspaceId, params.eventType, recipients, 'in_app')
    if (recipients.length === 0) return { recipients: [], inserted: true }

    const inserted = await insertNotificationRows(service, recipients.map(r => ({
      workspace_id: params.workspaceId,
      recipient_id: r.id,
      type:         params.type,
      title:        params.title,
      body:         params.body,
      entity_type:  params.entityType || null,
      entity_id:    params.entityId || null,
      project_id:   params.projectId || null,
    })))
    return { recipients, inserted }
  } catch (err) {
    console.error('notifyUsers failed:', err)
    return { recipients: [], inserted: false }
  }
}

/**
 * Security notices (MFA enabled / disabled / recovery used) concern the
 * person's account, not one workspace. They were inserted against a single
 * "active" workspace id — null for someone without one (violating NOT NULL,
 * silently) and invisible in the bell of every OTHER workspace they belong to.
 * Write one row per active membership instead.
 */
export async function notifySecurityEvent(service: any, userId: string, title: string, body: string): Promise<void> {
  try {
    const { data: memberships, error } = await service
      .from('workspace_members').select('workspace_id').eq('user_id', userId).eq('status', 'active')
    if (error) throw new Error(error.message)
    const rows = (memberships || []).map((m: any) => ({
      workspace_id: m.workspace_id, recipient_id: userId, type: 'security', title, body,
      entity_type: null, entity_id: null, project_id: null,
    }))
    await insertNotificationRows(service, rows)
  } catch (err) {
    console.error('notifySecurityEvent failed:', err)
  }
}
