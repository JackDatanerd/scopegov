// app/api/notifications/preferences/route.ts
import { getSession } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { ALL_EVENT_TYPES, IN_APP_ONLY_EVENT_TYPES as IN_APP_ONLY, isInAppOnly } from '@/lib/constants/notification-events'

// Event lists live in lib/constants/notification-events.ts (they were hand-synced in four places).
const IN_APP_ONLY_EVENT_TYPES: string[] = [...IN_APP_ONLY]

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()

    // FIX (deep audit, notifications section — flagship finding): a
    // workspace admin can now set an org-wide default per event
    // (app/api/workspace/notification-defaults) and optionally lock it so
    // members can't override it — see filterByNotificationPreference.
    // This route needs to reflect both: what actually resolves to (the
    // org default, when the member has no override) and whether the
    // toggle is even editable (locked).
    const [{ data: rows }, { data: defaultRows }] = await Promise.all([
      (service as any)
        .from('notification_preferences')
        .select('event_type, email_enabled, in_app_enabled')
        .eq('user_id', session.id)
        .eq('workspace_id', session.workspaceId),
      (service as any)
        .from('workspace_notification_defaults')
        .select('event_type, email_enabled, in_app_enabled, locked')
        .eq('workspace_id', session.workspaceId),
    ])

    const inAppOnly = new Set(IN_APP_ONLY_EVENT_TYPES)
    const defaultsByType = new Map((defaultRows || []).map((d: any) => [d.event_type, d]))

    // Absence of a row means "enabled" unless a workspace default says
    // otherwise — mirror filterByNotificationPreference's resolution here
    // so the UI matches what actually happens.
    const prefs: Record<string, boolean> = {}
    // FEATURE (Notifications & email fix round): the bell side of an EMAIL event could never be
    // muted — every write pinned in_app_enabled to true. `inAppPrefs` carries that second channel
    // for the email events (in-app-only events use `prefs` for their single channel).
    const inAppPrefs: Record<string, boolean> = {}
    const locked: Record<string, boolean> = {}
    for (const key of ALL_EVENT_TYPES) {
      const column = inAppOnly.has(key) ? 'in_app_enabled' : 'email_enabled'
      const def = defaultsByType.get(key) as any
      prefs[key] = def ? def[column] : true
      if (!inAppOnly.has(key)) inAppPrefs[key] = def ? def.in_app_enabled : true
      locked[key] = !!def?.locked
    }
    for (const row of rows || []) {
      // A locked default is authoritative — a stored row (even a stale one from before an admin
      // locked this event) never takes effect once locked, matching the read side exactly.
      if (locked[row.event_type]) continue
      prefs[row.event_type] = inAppOnly.has(row.event_type) ? row.in_app_enabled : row.email_enabled
      if (!inAppOnly.has(row.event_type)) inAppPrefs[row.event_type] = row.in_app_enabled
    }

    return NextResponse.json({ prefs, inAppPrefs, locked, inAppOnlyEventTypes: IN_APP_ONLY_EVENT_TYPES })
  } catch (err) {
    // FIX (deep audit, Settings re-pass): this returned err.message straight
    // to the client — same info-disclosure pattern already fixed for every
    // other Settings-adjacent route (workspace/settings, /defaults,
    // /branding, /branding/logo, workspace/notification-defaults). This
    // route's sibling on the admin side had the identical gap; both are
    // fixed together. Log server-side only.
    console.error('Notification preferences GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await request.json().catch(() => null)
    const { eventType, enabled, channel } = (body || {}) as { eventType?: string; enabled?: unknown; channel?: unknown }
    if (!eventType || !ALL_EVENT_TYPES.includes(eventType)) return NextResponse.json({ error: 'Unknown event type' }, { status: 400 })
    // FIX (Notifications & email fix round): `!!enabled` turned a missing / non-boolean value into
    // `false`, silently DISABLING the notification; require a real boolean.
    if (typeof enabled !== 'boolean') return NextResponse.json({ error: '`enabled` must be true or false' }, { status: 400 })
    if (channel !== undefined && channel !== 'email' && channel !== 'in_app')
      return NextResponse.json({ error: 'Unknown channel' }, { status: 400 })

    const service = createServiceClient()

    const { data: defaultRow } = await (service as any)
      .from('workspace_notification_defaults')
      .select('locked, email_enabled, in_app_enabled')
      .eq('workspace_id', session.workspaceId)
      .eq('event_type', eventType)
      .maybeSingle()
    if (defaultRow?.locked) {
      return NextResponse.json({ error: 'This notification is required by your workspace administrator' }, { status: 403 })
    }

    const inAppOnly = isInAppOnly(eventType)
    const targetChannel: 'email' | 'in_app' = inAppOnly ? 'in_app' : (channel === 'in_app' ? 'in_app' : 'email')

    // Preserve the channel being left alone. It used to be overwritten with `true` on every write,
    // so toggling one channel silently re-enabled the other.
    const { data: existing } = await (service as any)
      .from('notification_preferences')
      .select('email_enabled, in_app_enabled')
      .eq('user_id', session.id).eq('workspace_id', session.workspaceId).eq('event_type', eventType)
      .maybeSingle()
    const currentEmail = existing ? existing.email_enabled  : (defaultRow ? defaultRow.email_enabled  : true)
    const currentInApp = existing ? existing.in_app_enabled : (defaultRow ? defaultRow.in_app_enabled : true)

    const { error } = await (service as any)
      .from('notification_preferences')
      .upsert(
        {
          user_id: session.id, workspace_id: session.workspaceId, event_type: eventType,
          email_enabled:  inAppOnly ? true : (targetChannel === 'email'  ? enabled : currentEmail),
          in_app_enabled: inAppOnly ? enabled : (targetChannel === 'in_app' ? enabled : currentInApp),
        },
        { onConflict: 'user_id,workspace_id,event_type' }
      )

    if (error) {
      console.error('Notification preferences write failed:', error)
      return NextResponse.json({ error: 'Could not save this preference. Try again.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    // FIX (deep audit, Settings re-pass): same info-disclosure pattern as
    // GET above.
    console.error('Notification preferences PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
