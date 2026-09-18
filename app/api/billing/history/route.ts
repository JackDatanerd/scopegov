// app/api/billing/history/route.ts
//
// FEATURE (deep audit, Reports & Audit / Billing re-pass — feature gap):
// the `billing` table (001_initial_schema.sql) only ever stores CURRENT
// state — current_period_end, cancels_at_period_end, card-on-file — there
// has never been a ledger of past charges anywhere in this app. The only
// trace that a payment ever happened is the billing.payment_succeeded /
// billing.payment_failed_grace_started / etc. audit_log rows the webhook
// already writes (see app/api/billing/webhook/route.ts) — but reading
// those requires VIEW_AUDIT_LOG, a different permission than the one that
// actually manages billing (MANAGE_BILLING), and the audit log itself
// isn't shaped or labelled as a receipts list. A workspace owner with
// MANAGE_BILLING but not VIEW_AUDIT_LOG — a perfectly ordinary combination
// on this app's fully custom per-workspace roles — had no way at all to
// see what they'd been charged. Rather than duplicate a parallel ledger
// table that could drift from the audit trail, this reads the same
// audit_log rows the webhook already writes and reshapes them for the
// Billing tab.
export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'

const HISTORY_EVENT_TYPES = [
  'billing.payment_succeeded',
  'billing.payment_failed_grace_started',
  'billing.downgraded_for_nonpayment',
  'billing.subscription_ended',
  'billing.trial_expired',
  'billing.plan_changed',
]

const MAX_ROWS = 50

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const service = createServiceClient()
    const { data: rows } = await (service as any)
      .from('audit_log')
      .select('id, event_type, created_at, metadata')
      .eq('workspace_id', session.workspaceId)
      .in('event_type', HISTORY_EVENT_TYPES)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS)

    return NextResponse.json({
      rows: (rows || []).map((r: any) => ({
        id: r.id,
        eventType: r.event_type,
        createdAt: r.created_at,
        // FIX (deep audit, Reports & Audit / Billing re-pass): the amount
        // stored here now comes from the webhook's fromSubunit() — see
        // that file's comment for why it used to be 100x too large.
        amount: typeof r.metadata?.amount === 'number' ? r.metadata.amount : null,
        currency: r.metadata?.currency || null,
        action: r.metadata?.action || null,
      })),
    })
  } catch (err) {
    console.error('Billing history error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
