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
    const { data: rows, error } = await (service as any).from('billing')
      .select('workspace_id, paystack_subscription_code, current_period_end, cancels_at_period_end, grace_period_started_at, workspaces!inner(id, agency_name, deleted_at)')
      .not('paystack_subscription_code', 'is', null)
      .is('workspaces.deleted_at', null)
      .order('updated_at', { ascending: true })
      .limit(BATCH)
    if (error) throw new Error(error.message)

    let checked = 0, repaired = 0, readErrors = 0
    const anomalies: string[] = []

    for (const b of (rows || [])) {
      try {
        const res = await fetchPaystackSubscription(b.paystack_subscription_code)
        checked++
        if (!res.ok) {
          if (res.notFound) anomalies.push(`workspace ${b.workspace_id}: subscription ${b.paystack_subscription_code} NOT FOUND on Paystack`)
          else readErrors++
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

        if (Object.keys(updates).length) {
          const { error: upErr } = await (service as any).from('billing')
            .update({ ...updates, updated_at: new Date().toISOString() }).eq('workspace_id', b.workspace_id)
          if (upErr) { console.error('billing-reconcile update failed:', upErr.message); continue }
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
