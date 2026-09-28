// tests/payment-overdue-billing-race.test.ts
//
// FIX (deep audit, Billing re-pass — independent redo #4): steps 4 and 4b used to write
// ENDED_SUBSCRIPTION_FIELDS / needs_paystack_cancel conditioned on workspace_id alone. A plan
// switch (subscription.create) landing between the row being read and that write — reachable
// through the grace banner's own "Retry with a new card" button — would have its brand-new,
// already-paid subscription silently wiped from the billing row, or worse, flagged for a later
// cron run to actually cancel. These tests simulate that race by mutating the fake DB's billing
// row from inside the mocked cancelPaystackSubscription call (i.e. "while Paystack is being
// asked"), matching the real ordering: cancel call in flight -> webhook lands -> cancel call
// resolves -> the route's own write runs.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, alerts: [] as any[], cancelImpl: null as any }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async () => {} }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async () => {} }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => [] }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({
  alertBillingOps: async (_s: any, key: string, subject: string, lines: string[]) => { h.alerts.push({ key, subject, lines }); return true },
}))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async (b: any) => h.cancelImpl(b) }))
vi.mock('@/lib/email/templates', () => ({
  sendTrialWarningEmail: async () => {}, sendInvoiceOverdueInternalEmail: async () => {},
  sendPaymentMilestoneOverdueEmail: async () => {}, sendSubscriptionEndedEmail: async () => {},
  sendPaymentFailedEmail: async () => {},
}))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ id: `a${h.db.tables.audit_log.length}`, created_at: new Date().toISOString(), ...row }); return true },
}))

import { POST } from '@/app/api/cron/payment-overdue/route'

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const GRACE_DAYS = 5 // mirrors lib/billing/plans.ts, avoided importing to keep this test self-contained

const graceBilling = (workspaceId: string, subCode: string | null): Row => ({
  workspace_id: workspaceId, grace_period_started_at: ago(GRACE_DAYS + 1),
  paystack_subscription_code: subCode, paystack_email_token: subCode ? 'tok' : null,
  needs_paystack_cancel: false,
  workspaces: { id: workspaceId, agency_name: 'Agency', plan_tier: 'pro', deleted_at: null, created_by: 'u1', creator: { name: 'Cee', email: 'cee@agency.test' } },
})

const run = async () => { const res = await POST({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  h.alerts.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('payment-overdue step 4 — grace enforcement racing a concurrent plan switch', () => {
  it('does not wipe a brand-new subscription that lands while the old one is being cancelled, and reverts the downgrade', async () => {
    h.db = createFakeSupabase({
      billing: [graceBilling('w1', 'OLD_SUB')],
      workspaces: [{ id: 'w1', plan_tier: 'pro' }],
    })
    h.cancelImpl = async () => {
      // Simulate subscription.create's webhook landing mid-call: a plan switch replaces the
      // subscription code on the billing row while this cancel call is still in flight.
      const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w1')
      row.paystack_subscription_code = 'NEW_SUB'
      row.current_period_end = ago(-30)
      row.plan_interval = 'monthly'
      return { ok: true, alreadyCancelled: false }
    }

    await run()

    const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w1')
    expect(row.paystack_subscription_code).toBe('NEW_SUB') // must survive, not be nulled out
    expect(row.current_period_end).toBe(row.current_period_end) // untouched by ENDED_SUBSCRIPTION_FIELDS
    expect(row.needs_paystack_cancel).toBe(false)

    const ws = h.db.tables.workspaces.find((r: any) => r.id === 'w1')
    expect(ws.plan_tier).toBe('pro') // downgrade to 'solo' reverted once the race was detected

    // No stale-data audit row for a downgrade that got reverted.
    const downgradeRows = (h.db.tables.audit_log || []).filter((r: any) => r.event_type === 'billing.downgraded_for_nonpayment')
    expect(downgradeRows).toHaveLength(0)
  })

  it('flags needs_paystack_cancel and alerts ops when the cancel genuinely fails and nothing raced', async () => {
    h.db = createFakeSupabase({
      billing: [graceBilling('w2', 'OLD_SUB')],
      workspaces: [{ id: 'w2', plan_tier: 'pro' }],
    })
    h.cancelImpl = async () => ({ ok: false, error: 'Paystack unreachable' })

    await run()

    const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w2')
    expect(row.needs_paystack_cancel).toBe(true)
    expect(row.paystack_subscription_code).toBe('OLD_SUB') // left in place for step 4b to retry
    expect(h.alerts.some(a => a.key === 'billing:orphan-sub:w2')).toBe(true)

    const ws = h.db.tables.workspaces.find((r: any) => r.id === 'w2')
    expect(ws.plan_tier).toBe('solo') // genuine failure: downgrade stands
  })

  it('does NOT flag needs_paystack_cancel on a subscription a plan switch already superseded', async () => {
    h.db = createFakeSupabase({
      billing: [graceBilling('w3', 'OLD_SUB')],
      workspaces: [{ id: 'w3', plan_tier: 'pro' }],
    })
    h.cancelImpl = async () => {
      // The old subscription's cancel call fails AND a plan switch already replaced the row's
      // subscription code before this write runs — the new subscription must not inherit a
      // retry flag meant for the old, already-superseded one.
      const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w3')
      row.paystack_subscription_code = 'NEW_SUB'
      return { ok: false, error: 'Paystack unreachable' }
    }

    await run()

    const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w3')
    expect(row.paystack_subscription_code).toBe('NEW_SUB')
    expect(row.needs_paystack_cancel).toBe(false) // NEW_SUB must never be flagged for cancellation
    expect(h.alerts.some(a => a.key === 'billing:orphan-sub:w3')).toBe(false)

    const ws = h.db.tables.workspaces.find((r: any) => r.id === 'w3')
    expect(ws.plan_tier).toBe('pro') // reverted — the workspace just paid, it must not sit on 'solo'
  })
})

describe('payment-overdue step 4b — retry racing a concurrent plan switch', () => {
  it('does not wipe a brand-new subscription that lands while the retry call is in flight', async () => {
    h.db = createFakeSupabase({
      billing: [{
        workspace_id: 'w4', grace_period_started_at: null,
        paystack_subscription_code: 'OLD_SUB', paystack_email_token: 'tok',
        needs_paystack_cancel: true,
        workspaces: { id: 'w4', agency_name: 'Agency', plan_tier: 'pro', deleted_at: null, created_by: 'u1', creator: { name: 'Cee', email: 'cee@agency.test' } },
      }],
      workspaces: [{ id: 'w4', plan_tier: 'pro' }],
    })
    h.cancelImpl = async () => {
      const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w4')
      row.paystack_subscription_code = 'NEW_SUB'
      row.current_period_end = ago(-30)
      return { ok: true, alreadyCancelled: false }
    }

    await run()

    const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w4')
    expect(row.paystack_subscription_code).toBe('NEW_SUB')
  })
})
