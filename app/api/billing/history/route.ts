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
  'billing.payment_retry_failed',
  'billing.refund_processed',
  'billing.charge_dispute_create',
  'billing.charge_dispute_resolve',
  'billing.downgraded_for_nonpayment',
  'billing.subscription_ended',
  'billing.trial_expired',
  'billing.plan_changed',
]

const PAGE_SIZE = 25
const MAX_OFFSET = 500

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    // FEATURE (Billing re-pass #3): paged (it was a hard 50 with no way to see
    // older charges), deterministic order, and the read error is surfaced
    // instead of rendering an empty "no payments yet" list.
    const offset = Math.max(0, Math.min(parseInt(new URL(request.url).searchParams.get('offset') || '0', 10) || 0, MAX_OFFSET))
    const service = createServiceClient()
    const { data: rows, error } = await (service as any)
      .from('audit_log')
      .select('id, event_type, created_at, metadata')
      .eq('workspace_id', session.workspaceId)
      .in('event_type', HISTORY_EVENT_TYPES)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + PAGE_SIZE) // one extra row to know whether there is another page
    if (error) throw new Error(error.message)

    const page = (rows || []).slice(0, PAGE_SIZE)
    // FIX (deep audit, Billing re-pass — independent redo #2): every other
    // paginated/exportable view in this app (reports, audit log) explicitly
    // tells the reader when its cap was hit and data is being left out.
    // This route only ever signalled "no more pages" the same way whether
    // it ran out of real data OR simply hit MAX_OFFSET — "Load older" just
    // silently disappeared past 500 events with nothing to indicate older
    // ones still exist. `moreExists` is the same "was there another row
    // beyond this page" check `hasMore` already did; `truncated` is true
    // only in the specific case where more exists but the MAX_OFFSET cap
    // (not the actual data) is what's stopping us from reaching it.
    const moreExists = (rows || []).length > PAGE_SIZE
    const cappedOut = moreExists && offset + PAGE_SIZE >= MAX_OFFSET
    return NextResponse.json({
      hasMore: moreExists && !cappedOut,
      truncated: cappedOut,
      nextOffset: offset + page.length,
      rows: page.map((r: any) => ({
        id: r.id,
        eventType: r.event_type,
        createdAt: r.created_at,
        // Stored by the webhook via fromSubunit() (human units).
        amount: typeof r.metadata?.amount === 'number' ? r.metadata.amount : null,
        currency: r.metadata?.currency || null,
        action: r.metadata?.action || null,
        // Detail the UI previously could not show: every cancel, resume and
        // switch was just "Plan changed".
        from: r.metadata?.from || null,
        to: r.metadata?.to || null,
        interval: r.metadata?.to_interval || r.metadata?.interval || null,
        reference: r.metadata?.reference || null,
        channel: r.metadata?.channel || null,
        endsAt: r.metadata?.ends_at || null,
      })),
    })
  } catch (err) {
    console.error('Billing history error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
