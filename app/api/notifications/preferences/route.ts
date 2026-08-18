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
]

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()

    const { data: rows } = await (service as any)
      .from('notification_preferences')
      .select('event_type, email_enabled')
      .eq('user_id', session.id)
      .eq('workspace_id', session.workspaceId)

    // Absence of a row means "enabled" (see filterByNotificationPreference) —
    // mirror that default here so the UI matches what actually happens.
    const prefs: Record<string, boolean> = Object.fromEntries(EVENT_TYPES.map(k => [k, true]))
    for (const row of rows || []) prefs[row.event_type] = row.email_enabled

    return NextResponse.json({ prefs })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { eventType, enabled } = await request.json()
    if (!EVENT_TYPES.includes(eventType)) return NextResponse.json({ error: 'Unknown event type' }, { status: 400 })

    const service = createServiceClient()
    const { error } = await (service as any)
      .from('notification_preferences')
      .upsert(
        { user_id: session.id, workspace_id: session.workspaceId, event_type: eventType, email_enabled: !!enabled, in_app_enabled: true },
        { onConflict: 'user_id,workspace_id,event_type' }
      )

    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
