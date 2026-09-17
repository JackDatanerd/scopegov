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
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

const EMAIL_EVENT_TYPES = [
  'sow_signed', 'sow_declined', 'sow_changes_requested', 'co_accepted', 'co_declined', 'co_countered',
  'guardian_flag', 'escalation', 'trial_ending',
  'invoice_payment_received', 'invoice_overdue', 'approval_requested',
  'co_stalled', 'sow_stalled', 'sow_expired', 'approval_decision',
  // FIX (deep audit, notifications section): kept in sync with the same
  // addition in app/api/notifications/preferences/route.ts — see that
  // file's comment for why 'invoice_sent' belongs here now.
  'invoice_sent',
]
// FIX (deep audit, notifications section): kept in sync with the same
// addition in app/api/notifications/preferences/route.ts.
const IN_APP_ONLY_EVENT_TYPES = ['approval_no_reachable_approver', 'flag_comment_added', 'project_message_mention']
const ALL_EVENT_TYPES = [...EMAIL_EVENT_TYPES, ...IN_APP_ONLY_EVENT_TYPES]

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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
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

    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
