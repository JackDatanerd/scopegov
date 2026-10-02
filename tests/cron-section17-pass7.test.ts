// tests/cron-section17-pass7.test.ts
//
// Regression tests for the section-17 (cron) independent pass 7 — both in payment-overdue step 5
// (cancelled subscriptions past their paid period end):
//   B1 — the rollback that re-arms cancels_at_period_end after a failed downgrade was never checked, so a
//        failure of BOTH writes left a paid workspace that no later run would ever pick up, with no signal
//   B2 — the sweep nulled paystack_customer_code, which every other ended-subscription write keeps on purpose
//        so late events for the dead subscription still resolve (and are ignored as superseded)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async () => {} }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async () => true }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => [] }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async () => ({ ok: true }) }))
vi.mock('@/lib/email/templates', () => ({
  sendTrialWarningEmail: async () => ({ ok: true }), sendInvoiceOverdueInternalEmail: async () => ({ ok: true }),
  sendPaymentMilestoneOverdueEmail: async () => ({ ok: true }), sendSubscriptionEndedEmail: async () => ({ ok: true }),
  sendPaymentFailedEmail: async () => ({ ok: true }),
}))
vi.mock('@/lib/utils/audit', () => ({ insertAuditRow: async () => true }))
vi.mock('@/lib/approvals/engine', () => ({
  healStuckSends: async () => [], documentLabelFor: (t: string) => t, sendApprovalReminder: async () => 'sent',
}))

import { POST as paymentOverdue } from '@/app/api/cron/payment-overdue/route'

const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const call = async (fn: any) => { const res = await fn({} as any); return { status: res.status, body: await res.json() } }

const ws = () => ({ id: 'w1', agency_name: 'A', plan_tier: 'pro', deleted_at: null, created_by: 'u1', creator: null })
const cancelling = (): Row => ({
  workspace_id: 'w1', cancels_at_period_end: true, current_period_end: ago(1),
  paystack_subscription_code: 'SUB_1', paystack_customer_code: 'CUS_1', paystack_email_token: 'tok',
  plan_interval: 'monthly', payment_method_last4: '4242', payment_method_type: 'card', workspaces: ws(),
})

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('B2 — the period-end sweep keeps the customer code', () => {
  it('ends the subscription, downgrades, and leaves paystack_customer_code on the row', async () => {
    h.db = createFakeSupabase({ billing: [cancelling()], workspaces: [{ id: 'w1', plan_tier: 'pro' }] })
    const { body } = await call(paymentOverdue)
    expect(body.cancelledSubscriptionsEnded).toBe(1)
    const row = h.db.tables.billing[0]
    expect(h.db.tables.workspaces[0].plan_tier).toBe('solo')
    expect(row.paystack_subscription_code).toBeNull()
    expect(row.cancels_at_period_end).toBe(false)
    expect(row.paystack_customer_code).toBe('CUS_1')
  })
})

describe('B1 — a failed downgrade whose rollback also fails is reported, not swallowed', () => {
  it('rollback succeeds: the row is re-armed for the next run and the error is the plain downgrade failure', async () => {
    h.db = createFakeSupabase(
      { billing: [cancelling()], workspaces: [{ id: 'w1', plan_tier: 'pro' }] },
      { errors: [{ table: 'workspaces', op: 'update', message: 'db blip' }] },
    )
    const { body } = await call(paymentOverdue)
    expect(body.cancelledSubscriptionsEnded).toBe(0)
    const row = h.db.tables.billing[0]
    expect(row.cancels_at_period_end).toBe(true)
    expect(row.paystack_subscription_code).toBe('SUB_1')
    expect(row.paystack_customer_code).toBe('CUS_1')
    expect(h.db.tables.workspaces[0].plan_tier).toBe('pro')
    const errs = (body.rowErrors || []).join(' ')
    expect(errs).toMatch(/downgrade failed for w1: db blip/)
    expect(errs).not.toMatch(/restoring the cancelled-subscription marker failed/)
  })

  it('rollback also fails: the row stays un-armed, but the failure says so and names the manual fix', async () => {
    h.db = createFakeSupabase(
      { billing: [cancelling()], workspaces: [{ id: 'w1', plan_tier: 'pro' }] },
      { errors: [
        { table: 'workspaces', op: 'update', message: 'db blip' },
        // the restore is the only billing write that sets cancels_at_period_end back to true
        { table: 'billing', op: 'update', message: 'still down', when: (p: any) => p?.cancels_at_period_end === true },
      ] },
    )
    const { body } = await call(paymentOverdue)
    expect(body.cancelledSubscriptionsEnded).toBe(0)
    expect(h.db.tables.billing[0].cancels_at_period_end).toBe(false) // nothing will select it again…
    expect(h.db.tables.workspaces[0].plan_tier).toBe('pro')           // …so the workspace is still paid
    const errs = (body.rowErrors || []).join(' ')
    expect(errs).toMatch(/restoring the cancelled-subscription marker failed: still down/)
    expect(errs).toMatch(/set plan_tier to 'solo' by hand/)
  })
})
