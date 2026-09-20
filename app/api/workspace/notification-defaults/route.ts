// app/api/workspace/notification-defaults/route.ts
//
// FIX (deep audit, notifications section — flagship finding): this route
// didn't exist at all. workspace_notification_defaults has had a full
// schema (including `locked`) and RLS policies since early migrations,
// and gets seeded with a row per new event type across three separate
// migrations (004, 007, 009) — but nothing ever read or wrote it. This is
// the admin-facing half of that; see filterByNotificationPreference in
// lib/utils/permissions-query.ts for the read-side half that makes these
// values actually take effect.
//
// Event-type list is intentionally the same set (and kept in sync the
// same manual way) as EVENT_TYPES/IN_APP_ONLY_EVENT_TYPES in
// app/api/notifications/preferences/route.ts and NOTIF_ITEMS/
// IN_APP_NOTIF_ITEMS in components/settings/SettingsClient.tsx — matching
// how those two already relate rather than introducing a new pattern.
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { ALL_EVENT_TYPES as ALL_EVENTS, EMAIL_EVENT_TYPES as EMAIL_EVENTS, IN_APP_ONLY_EVENT_TYPES as IN_APP_ONLY } from '@/lib/constants/notification-events'

// Lists live in lib/constants/notification-events.ts (they were hand-synced in four places).
const EMAIL_EVENT_TYPES: string[] = [...EMAIL_EVENTS]
const IN_APP_ONLY_EVENT_TYPES: string[] = [...IN_APP_ONLY]
const ALL_EVENT_TYPES: string[] = [...ALL_EVENTS]

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // Reading current org defaults is only meaningful to whoever can set
    // them — same gate as writing, unlike the personal preferences route
    // (which every member can read/write for themselves).
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }
    const service = createServiceClient()
    const { data: rows } = await (service as any)
      .from('workspace_notification_defaults')
      .select('event_type, email_enabled, in_app_enabled, locked')
      .eq('workspace_id', session.workspaceId)

    // Absence of a row means "enabled, unlocked" — same default the read
    // side (filterByNotificationPreference) falls back to.
    const defaults: Record<string, { emailEnabled: boolean; inAppEnabled: boolean; locked: boolean }> =
      Object.fromEntries(ALL_EVENT_TYPES.map(k => [k, { emailEnabled: true, inAppEnabled: true, locked: false }]))
    for (const row of rows || []) {
      defaults[row.event_type] = {
        emailEnabled: row.email_enabled, inAppEnabled: row.in_app_enabled, locked: row.locked,
      }
    }

    return NextResponse.json({ defaults, emailEventTypes: EMAIL_EVENT_TYPES, inAppOnlyEventTypes: IN_APP_ONLY_EVENT_TYPES })
  } catch (err) {
    // FIX (deep audit, Settings re-pass): this returned err.message straight
    // to the client — the same info-disclosure pattern already fixed for
    // every other Settings route (workspace/settings, /defaults, /branding,
    // /branding/logo all log server-side and return a generic message).
    // This route and its sibling PATCH below were missed. Log server-side
    // only.
    console.error('Workspace notification-defaults GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }
    const { eventType, enabled, locked } = await request.json()
    if (!ALL_EVENT_TYPES.includes(eventType)) {
      return NextResponse.json({ error: 'Unknown event type' }, { status: 400 })
    }

    const service = createServiceClient()
    const isInAppOnly = IN_APP_ONLY_EVENT_TYPES.includes(eventType)

    // Same shape as the personal-preferences PATCH: in-app-only event
    // types set in_app_enabled; every other event type sets email_enabled
    // while in_app_enabled stays true (matching what the rest of the app
    // already assumes about those events). `locked` applies to both
    // columns at once — an admin locking an event makes the whole thing
    // mandatory, not just one channel of it.
    const { data: existing } = await (service as any)
      .from('workspace_notification_defaults')
      .select('id')
      .eq('workspace_id', session.workspaceId)
      .eq('event_type', eventType)
      .maybeSingle()

    const payload = {
      workspace_id:   session.workspaceId,
      event_type:     eventType,
      email_enabled:  isInAppOnly ? true : !!enabled,
      in_app_enabled: isInAppOnly ? !!enabled : true,
      locked:         !!locked,
    }

    const { error } = existing?.id
      ? await (service as any).from('workspace_notification_defaults').update(payload).eq('id', existing.id)
      : await (service as any).from('workspace_notification_defaults').insert(payload)

    if (error) {
      console.error('Workspace notification-defaults write failed:', error)
      return NextResponse.json({ error: 'Could not save this notification default. Try again.' }, { status: 500 })
    }

    // FIX (Reports & Audit re-pass #3): this is a workspace-wide governance
    // setting (an admin can LOCK an event so members cannot opt out of it)
    // and it was the one MANAGE_WORKSPACE_SETTINGS mutation with no audit
    // event, while workspace.settings_updated / workspace.defaults_updated
    // both log. Who changed which mandatory notification, and when, belongs
    // in the trail.
    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.notification_defaults_updated',
      entityType: 'workspace_defaults', entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { event_type: eventType, enabled: !!enabled, locked: !!locked },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    // FIX (deep audit, Settings re-pass): same info-disclosure pattern as
    // GET above — log server-side, return a generic message.
    console.error('Workspace notification-defaults PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
