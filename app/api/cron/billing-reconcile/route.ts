// app/api/cron/billing-reconcile/route.ts
//
// FEATURE (Billing re-pass #3): billing state here is maintained entirely by
// webhooks, and until now nothing ever compared it with Paystack. A missed or
// mis-attributed delivery (Paystack retries for a limited time, the webhook
// route can be down, an event can be for a workspace we could not resolve)
// left local state permanently wrong with no way to notice: a subscription
// cancelled upstream still showing as renewing, a stale current_period_end
// that the period-end sweep would act on, an orphaned or vanished
// subscription. This daily job re-reads every live subscription from Paystack
// and (a) repairs the two drifts that are unambiguous, and (b) reports the
// rest to ops rather than guessing.
//
// Repaired automatically:
//   - Paystack says cancelled / non-renewing / completed, we say renewing
//     -> cancels_at_period_end = true (the period-end sweep then handles it)
//   - Paystack's next_payment_date is later than our current_period_end
//     -> current_period_end moves forward (never backward)
// Reported only:
//   - subscription not found upstream
//   - Paystack says active but we show a pending cancellation
//   - Paystack says "attention" (charge failing) but no grace period started
export const runtime = 'nodejs'
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'
import { fetchPaystackSubscription } from '@/lib/integrations/paystack'
import { alertBillingOps } from '@/lib/billing/ops-alert'
import { insertAuditRow } from '@/lib/utils/audit'

const BATCH = 200
const CANCELLED_STATES = new Set(['cancelled', 'non-renewing', 'completed', 'complete'])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    // FIX (cron audit, section 17 re-pass — starvation bug): this used to order by
    // `updated_at`, which is only touched on an actual repair (see the update below) —
    // a row checked and found clean never moved, so past 200 live subscriptions the
    // same oldest-by-updated_at rows were re-selected every day and everything past
    // the batch boundary was never reconciled again. `last_reconciled_at` (migration
    // 072) is bumped on every check regardless of outcome, so this now rotates
    // through the whole table; nullsFirst picks up rows that have never been checked
    // even once (new rows, and every existing row as of the migration) before
    // anything already-checked.
    const { data: rows, error } = await (service as any).from('billing')
      .select('workspace_id, paystack_subscription_code, current_period_end, cancels_at_period_end, grace_period_started_at, workspaces!inner(id, agency_name, deleted_at)')
      .not('paystack_subscription_code', 'is', null)
      .is('workspaces.deleted_at', null)
      .order('last_reconciled_at', { ascending: true, nullsFirst: true })
      .limit(BATCH)
    if (error) throw new Error(error.message)

    let checked = 0, repaired = 0, readErrors = 0
    const anomalies: string[] = []

    for (const b of (rows || [])) {
      try {
        const res = await fetchPaystackSubscription(b.paystack_subscription_code)
        checked++
        if (!res.ok) {
          if (res.notFound) {
            anomalies.push(`workspace ${b.workspace_id}: subscription ${b.paystack_subscription_code} NOT FOUND on Paystack`)
            // FIX (cron audit, section 17 re-pass): a "not found" is still a
            // definitive, successful check — stamp the cursor so this row
            // cycles through the queue like any other, instead of pinning
            // itself at the front forever (see migration 072 / the query
            // comment above).
            const { error: cursorErr } = await (service as any).from('billing')
              .update({ last_reconciled_at: new Date().toISOString() }).eq('workspace_id', b.workspace_id)
            if (cursorErr) console.error('billing-reconcile: cursor update failed:', cursorErr.message)
          } else {
            // A transient read failure is NOT a completed check — leave
            // last_reconciled_at untouched so this row is retried before the
            // batch advances past it, rather than silently skipped for a
            // whole cycle.
            readErrors++
          }
          continue
        }
        const { status, nextPaymentDate } = res.sub

        const updates: Record<string, unknown> = {}
        const changes: Record<string, unknown> = {}

        if (status && CANCELLED_STATES.has(status) && !b.cancels_at_period_end) {
          updates.cancels_at_period_end = true
          changes.cancels_at_period_end = { from: false, to: true, paystack_status: status }
        }
        if (nextPaymentDate && !isNaN(Date.parse(nextPaymentDate)) && Date.parse(nextPaymentDate) > Date.now()) {
          const local = b.current_period_end ? Date.parse(b.current_period_end) : 0
          if (Date.parse(nextPaymentDate) > local + 3600_000) {
            updates.current_period_end = nextPaymentDate
            changes.current_period_end = { from: b.current_period_end, to: nextPaymentDate }
          }
        }

        if (status === 'active' && b.cancels_at_period_end)
          anomalies.push(`workspace ${b.workspace_id}: Paystack shows ACTIVE but a cancellation is pending locally (${b.paystack_subscription_code})`)
        if (status === 'attention' && !b.grace_period_started_at)
          anomalies.push(`workspace ${b.workspace_id}: Paystack shows ATTENTION (charge failing) but no grace period is running (${b.paystack_subscription_code})`)

        // FIX (cron audit, section 17 re-pass — starvation bug): `updated_at`
        // stays reserved for an actual repair (its existing meaning
        // elsewhere in the app); `last_reconciled_at` is a separate cursor
        // stamped on every successful check, repaired or not, which is what
        // the batch query above now orders by. Without this, a subscription
        // that's clean every day never moved in the old ordering and, past
        // BATCH=200 live subscriptions, would never be checked again.
        const hasRepair = Object.keys(changes).length > 0
        const writeFields: Record<string, unknown> = { ...updates, last_reconciled_at: new Date().toISOString() }
        if (hasRepair) writeFields.updated_at = new Date().toISOString()

        const { error: upErr } = await (service as any).from('billing')
          .update(writeFields).eq('workspace_id', b.workspace_id)
        if (upErr) { console.error('billing-reconcile update failed:', upErr.message); continue }
        if (hasRepair) {
          repaired++
          await insertAuditRow(service, {
            workspace_id: b.workspace_id, actor_id: null,
            actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
            event_type: 'billing.reconciled', entity_type: 'workspace',
            entity_id: b.workspace_id, entity_name: b.workspaces?.agency_name, metadata: changes,
          })
        }
      } catch (e) { console.error('billing-reconcile row error:', e); readErrors++ }
      await sleep(120) // stay well inside Paystack's rate limits
    }

    if (anomalies.length) {
      await alertBillingOps(service, 'billing:reconcile-anomalies', `${anomalies.length} billing anomal${anomalies.length === 1 ? 'y' : 'ies'} found by reconciliation`, anomalies, 23 * 3600_000)
    }

    await recordCronHeartbeat(service, 'billing-reconcile', { checked, repaired, anomalies: anomalies.length, readErrors })
    return NextResponse.json({ ok: true, checked, repaired, anomalies: anomalies.length, readErrors })
  } catch (err) {
    console.error('Billing reconcile cron error:', err)
    await alertCronFailure(createServiceClient(), 'billing-reconcile', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

export const GET = POST
