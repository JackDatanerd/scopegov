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
  // FIX (section-9 audit, 9-G3): the new sow-expiry cron notifies on this
  // — same whitelist requirement as every entry above, otherwise PATCH
  // 400s on it and the toggle can never be saved.
  'sow_expired',
  // FIX (deep audit, notifications section): notifyRequester (approval
  // engine) sends this on every approve/reject decision but had no
  // whitelist entry at all — same "permanently un-mutable" bug as every
  // entry above, except this one wasn't even gated in code (see that
  // function's fix comment). Covers both 'approval_approved' and
  // 'approval_rejected' notification types under one toggle, since both
  // tell the same person (the requester) about the outcome of their own
  // request.
  'approval_decision',
  // FIX (deep audit, notifications section): migration 004 seeded
  // workspace_notification_defaults with 'invoice_sent' as a third sibling
  // alongside 'invoice_payment_received' and 'invoice_overdue' — those two
  // got full wiring (notify call, email template, this whitelist); this one
  // never did, so an invoice going out told the client and nobody on the
  // internal team. See sendInvoiceSentInternalEmail and its call site in
  // app/api/invoices/[id]/send/route.ts.
  'invoice_sent',
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
// FIX (deep audit, notifications section): 'project_message_mention' had
// the identical "seeded in a migration, never added to this whitelist"
// gap as flag_comment_added above — see migration 009's own comment,
// which describes this exact bug and says it's "harmless today" because
// nothing reads workspace_notification_defaults for it. That stopped
// being true the moment filterByNotificationPreference became the real
// choke point (see lib/utils/permissions-query.ts and
// lib/utils/project-messages.ts), so mentions need the same whitelist
// entry flag_comment_added already has, for the same reason: no email
// counterpart exists for either, so both belong here rather than in
// EVENT_TYPES.
const IN_APP_ONLY_EVENT_TYPES = ['approval_no_reachable_approver', 'flag_comment_added', 'project_message_mention']

const ALL_EVENT_TYPES = [...EVENT_TYPES, ...IN_APP_ONLY_EVENT_TYPES]

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
    const locked: Record<string, boolean> = {}
    for (const key of ALL_EVENT_TYPES) {
      const column = inAppOnly.has(key) ? 'in_app_enabled' : 'email_enabled'
      const def = defaultsByType.get(key) as any
      prefs[key] = def ? def[column] : true
      locked[key] = !!def?.locked
    }
    for (const row of rows || []) {
      // A locked default is authoritative — an individual's stored row
      // (even a stale one from before an admin locked this event) never
      // takes effect once locked, matching the read side exactly.
      if (locked[row.event_type]) continue
      prefs[row.event_type] = inAppOnly.has(row.event_type) ? row.in_app_enabled : row.email_enabled
    }

    return NextResponse.json({ prefs, locked, inAppOnlyEventTypes: IN_APP_ONLY_EVENT_TYPES })
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

    // FIX (deep audit, notifications section — flagship finding): a
    // member could otherwise write a preference row for an event an
    // admin has locked — the row would simply never take effect (see
    // filterByNotificationPreference), but the toggle would look saved,
    // silently lying to whoever clicked it.
    const { data: lockedRow } = await (service as any)
      .from('workspace_notification_defaults')
      .select('locked')
      .eq('workspace_id', session.workspaceId)
      .eq('event_type', eventType)
      .maybeSingle()
    if (lockedRow?.locked) {
      return NextResponse.json({ error: 'This notification is required by your workspace administrator' }, { status: 403 })
    }

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
