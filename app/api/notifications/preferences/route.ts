// app/api/notifications/preferences/route.ts
import { getSession } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { staleWorkspaceResponse } from '@/lib/utils/workspace-guard'
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
    const [{ data: rows, error: rowsErr }, { data: defaultRows, error: defaultsErr }] = await Promise.all([
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

    // FIX (Notifications & email independent pass 5): neither query's `error` was read (supabase-js returns it, it does not
    // throw), so a failed read answered 200 with every toggle ON and nothing locked — the Settings tab then showed
    // notifications as enabled that the person had muted, and let them toggle against a state that was never loaded.
    // A failed read is a 500, like GET /api/notifications.
    if (rowsErr || defaultsErr) {
      console.error('Notification preferences GET read failed:', rowsErr?.message || defaultsErr?.message)
      return NextResponse.json({ error: 'Could not load notification preferences' }, { status: 500 })
    }

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
      // NULL = the member never chose that channel (migration 142): keep the workspace default resolved above.
      const own = inAppOnly.has(row.event_type) ? row.in_app_enabled : row.email_enabled
      if (own !== null && own !== undefined) prefs[row.event_type] = own
      if (!inAppOnly.has(row.event_type) && row.in_app_enabled !== null && row.in_app_enabled !== undefined)
        inAppPrefs[row.event_type] = row.in_app_enabled
    }

    return NextResponse.json({ workspaceId: session.workspaceId, prefs, inAppPrefs, locked, inAppOnlyEventTypes: IN_APP_ONLY_EVENT_TYPES })
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
    // Stale-tab guard (lib/utils/workspace-guard.ts): without it a toggle made in a tab left open from before a workspace
    // switch is saved against whichever workspace is active now.
    const stale = staleWorkspaceResponse((body as any)?.workspaceId, session.workspaceId)
    if (stale) return stale
    const { eventType, enabled, channel } = (body || {}) as { eventType?: string; enabled?: unknown; channel?: unknown }
    if (!eventType || !ALL_EVENT_TYPES.includes(eventType)) return NextResponse.json({ error: 'Unknown event type' }, { status: 400 })
    // FIX (Notifications & email fix round): `!!enabled` turned a missing / non-boolean value into
    // `false`, silently DISABLING the notification; require a real boolean.
    if (typeof enabled !== 'boolean') return NextResponse.json({ error: '`enabled` must be true or false' }, { status: 400 })
    if (channel !== undefined && channel !== 'email' && channel !== 'in_app')
      return NextResponse.json({ error: 'Unknown channel' }, { status: 400 })

    const service = createServiceClient()

    const { data: defaultRow, error: defaultErr } = await (service as any)
      .from('workspace_notification_defaults')
      .select('locked, email_enabled, in_app_enabled')
      .eq('workspace_id', session.workspaceId)
      .eq('event_type', eventType)
      .maybeSingle()
    // FIX (Notifications & email independent pass 5): a failed read of the workspace default was treated as "no default,
    // not locked" — it skipped the lock check and resolved the untouched channel against the wrong baseline.
    if (defaultErr) {
      console.error('Notification preferences PATCH default read failed:', defaultErr.message)
      return NextResponse.json({ error: 'Could not save this preference. Try again.' }, { status: 500 })
    }
    if (defaultRow?.locked) {
      return NextResponse.json({ error: 'This notification is required by your workspace administrator' }, { status: 403 })
    }

    const inAppOnly = isInAppOnly(eventType)
    const targetChannel: 'email' | 'in_app' = inAppOnly ? 'in_app' : (channel === 'in_app' ? 'in_app' : 'email')

    // Preserve the channel being left alone. It used to be overwritten with `true` on every write,
    // so toggling one channel silently re-enabled the other.
    const { data: existing, error: existingErr } = await (service as any)
      .from('notification_preferences')
      .select('email_enabled, in_app_enabled')
      .eq('user_id', session.id).eq('workspace_id', session.workspaceId).eq('event_type', eventType)
      .maybeSingle()
    // FIX (Notifications & email independent pass 5): a failed read made `existing` null, so the channel being LEFT ALONE
    // fell back to the workspace default and was then written as the person's explicit choice — toggling one channel
    // silently reset the other.
    if (existingErr) {
      console.error('Notification preferences PATCH read failed:', existingErr.message)
      return NextResponse.json({ error: 'Could not save this preference. Try again.' }, { status: 500 })
    }
    // FIX (Notifications & email pass 6): this wrote BOTH columns from the row read above, so two overlapping PATCHes
    // let the second write back the first one's stale value. Only the targeted column is ever updated now.
    // FIX (Notifications & email, independent pass): a missing row used to be created with the channel being LEFT ALONE
    // resolved against today's workspace default and stored as the person's explicit choice — a later change to that
    // default never reached them for that channel. The untouched channel is now NULL ("follow the workspace default",
    // migration 142); only the channel the person actually toggled is stored.
    const targetColumn = targetChannel === 'in_app' ? 'in_app_enabled' : 'email_enabled'
    const where = { user_id: session.id, workspace_id: session.workspaceId, event_type: eventType }
    let error: { message?: string; code?: string } | null = null
    if (!existing) {
      const conflict = { onConflict: 'user_id,workspace_id,event_type', ignoreDuplicates: true }
      let created = await (service as any).from('notification_preferences')
        .upsert({ ...where, email_enabled: null, in_app_enabled: null }, conflict)
      // Migration 142 not applied yet (columns still NOT NULL): fall back to the old behaviour — baseline from the
      // workspace default for the channel left alone — rather than failing the save.
      if (created.error?.code === '23502') {
        const baseEmail = defaultRow ? defaultRow.email_enabled : true
        const baseInApp = defaultRow ? defaultRow.in_app_enabled : true
        created = await (service as any).from('notification_preferences')
          .upsert({ ...where, email_enabled: baseEmail, in_app_enabled: baseInApp }, conflict)
      }
      error = created.error
    }
    if (!error) {
      const updated = await (service as any)
        .from('notification_preferences')
        .update({ [targetColumn]: enabled })
        .eq('user_id', where.user_id).eq('workspace_id', where.workspace_id).eq('event_type', eventType)
      error = updated.error
    }

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
