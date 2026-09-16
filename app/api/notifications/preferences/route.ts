// app/api/notifications/preferences/route.ts
import { getSession } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

const EVENT_TYPES = [
  'sow_signed', 'sow_declined', 'sow_changes_requested', 'co_accepted', 'co_declined', 'co_countered',
  'guardian_flag', 'escalation', 'trial_ending',
  // FIX (audit): these three are fully gated through filterByNotificationPreference
  // in code (invoices/[id]/payments, cron/payment-overdue, approvals/engine) but
  // were missing from this whitelist — PATCH would 400 on them and the Settings
  // UI had no toggle, so they were permanently un-mutable.
  'invoice_payment_received', 'invoice_overdue', 'approval_requested',
  // FIX (build, cron section): co-stall/sow-stall now actually notify (see
  // cron/co-stall and cron/sow-stall) — same whitelist requirement as above.
  'co_stalled', 'sow_stalled',
]

// FIX (re-audit, notifications section): `approval_no_reachable_approver`
// (cron/approval-stall) and `flag_comment_added` (scope-governance comments)
// are both filtered through filterByNotificationPreference the same way the
// nine EVENT_TYPES above are, and had the exact same "missing from the
// whitelist, permanently un-mutable" bug this file has already been patched
// for three times. But neither has an email counterpart at all —
// notifyMembersWithPermission only ever creates in-app rows; nothing calls a
// sendXxxEmail template for these two event types. Bolting them onto
// EVENT_TYPES (which the UI renders under "Email notifications" and which
// PATCH writes to `email_enabled`) would produce a toggle that visibly does
// nothing — there's no email being gated by that column for these events.
// They're mutable through the `in_app_enabled` column instead, which is
// otherwise hardcoded true everywhere in this file. Kept as a separate list
// so GET/PATCH can read and write the correct column per event type instead
// of assuming every mutable event is an email event.
const IN_APP_ONLY_EVENT_TYPES = ['approval_no_reachable_approver', 'flag_comment_added']

const ALL_EVENT_TYPES = [...EVENT_TYPES, ...IN_APP_ONLY_EVENT_TYPES]

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()

    const { data: rows } = await (service as any)
      .from('notification_preferences')
      .select('event_type, email_enabled, in_app_enabled')
      .eq('user_id', session.id)
      .eq('workspace_id', session.workspaceId)

    // Absence of a row means "enabled" (see filterByNotificationPreference) —
    // mirror that default here so the UI matches what actually happens.
    const prefs: Record<string, boolean> = Object.fromEntries(ALL_EVENT_TYPES.map(k => [k, true]))
    const inAppOnly = new Set(IN_APP_ONLY_EVENT_TYPES)
    for (const row of rows || []) {
      prefs[row.event_type] = inAppOnly.has(row.event_type) ? row.in_app_enabled : row.email_enabled
    }

    return NextResponse.json({ prefs, inAppOnlyEventTypes: IN_APP_ONLY_EVENT_TYPES })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { eventType, enabled } = await request.json()
    if (!ALL_EVENT_TYPES.includes(eventType)) return NextResponse.json({ error: 'Unknown event type' }, { status: 400 })

    const service = createServiceClient()
    // In-app-only event types toggle `in_app_enabled`; every other event type
    // keeps the existing behaviour of toggling `email_enabled` while
    // `in_app_enabled` stays pinned true. Both columns are NOT NULL, so a
    // value has to be supplied either way — the one not being toggled is set
    // to its harmless default (nothing reads it for that half of the split).
    const isInAppOnly = IN_APP_ONLY_EVENT_TYPES.includes(eventType)
    const { error } = await (service as any)
      .from('notification_preferences')
      .upsert(
        {
          user_id: session.id, workspace_id: session.workspaceId, event_type: eventType,
          email_enabled:  isInAppOnly ? true : !!enabled,
          in_app_enabled: isInAppOnly ? !!enabled : true,
        },
        { onConflict: 'user_id,workspace_id,event_type' }
      )

    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
