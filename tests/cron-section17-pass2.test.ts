// tests/cron-section17-pass2.test.ts
//
// Regression tests for the section-17 (cron) independent pass 2:
//   B1 — payment-overdue steps 1/1b and reconciliation-rollup ignored soft-deleted / admin-suspended workspaces
//   B2 — payment-overdue grace/cancelled downgrade could overwrite a plan a concurrent plan switch had just set
//   B3 — approval-stall ignored a failed write of its own dedupe marker (audit row)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, notified: [] as any[], cancelImpl: null as any, auditOk: true, reminder: 'sent' as string }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async () => {} }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async (_s: any, p: any) => { h.notified.push(p) } }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => [] }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async (b: any) => h.cancelImpl(b) }))
vi.mock('@/lib/email/templates', () => ({
  sendTrialWarningEmail: async () => ({ ok: true }), sendInvoiceOverdueInternalEmail: async () => ({ ok: true }),
  sendPaymentMilestoneOverdueEmail: async () => ({ ok: true }), sendSubscriptionEndedEmail: async () => ({ ok: true }),
  sendPaymentFailedEmail: async () => ({ ok: true }),
}))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => {
    if (!h.auditOk) return false
    h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ id: `a${h.db.tables.audit_log.length}`, created_at: new Date().toISOString(), ...row }); return true
  },
}))
vi.mock('@/lib/approvals/engine', () => ({
  healStuckSends: async () => [], documentLabelFor: (t: string) => t, sendApprovalReminder: async () => h.reminder,
}))
vi.mock('@/lib/reports/contract-position', () => ({
  computeContractPositions: async (_s: any, projects: any[]) =>
    new Map(projects.map(p => [p.id, { contractedValue: 1, invoicedToDate: 0, paidToDate: 0, atRiskValue: 0 }])),
}))

import { POST as paymentOverdue } from '@/app/api/cron/payment-overdue/route'
import { POST as rollup } from '@/app/api/cron/reconciliation-rollup/route'
import { POST as approvalStall } from '@/app/api/cron/approval-stall/route'

const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const day = (d: number) => ago(d).split('T')[0]
const call = async (fn: any) => { const res = await fn({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  h.notified.length = 0; h.auditOk = true; h.reminder = 'sent'
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('B1 — deleted / suspended workspaces are left alone', () => {
  const milestone = (id: string, wsDeleted: string | null): Row => ({
    id, status: 'pending', type: 'fixed', title: 'M', amount: 100, due_date: day(3), project_id: `p-${id}`,
    projects: { id: `p-${id}`, name: 'P', workspace_id: `w-${id}`, currency: 'USD', deleted_at: null, clients: { name: 'C' }, workspaces: { deleted_at: wsDeleted } },
  })
  const invoice = (id: string, wsDeleted: string | null): Row => ({
    id, status: 'sent', title: 'I', amount: 100, amount_paid: 0, currency: 'USD', invoice_number: id, workspace_id: `w-${id}`, due_date: day(3),
    projects: { id: `p-${id}`, name: 'P', deleted_at: null, clients: { name: 'C' } }, workspaces: { deleted_at: wsDeleted },
  })

  it('payment-overdue does not flip milestones or invoices of a deleted workspace, but still handles live ones', async () => {
    h.db = createFakeSupabase({
      payment_milestones: [milestone('live', null), milestone('dead', ago(2))],
      invoices: [invoice('live', null), invoice('dead', ago(2))],
    })
    const { body } = await call(paymentOverdue)
    expect(body.milestonesMarkedOverdue).toBe(1)
    expect(body.invoicesOverdue).toBe(1)
    const ms = h.db.tables.payment_milestones, inv = h.db.tables.invoices
    expect(ms.find((r: Row) => r.id === 'live').status).toBe('overdue')
    expect(ms.find((r: Row) => r.id === 'dead').status).toBe('pending')
    expect(inv.find((r: Row) => r.id === 'live').status).toBe('overdue')
    expect(inv.find((r: Row) => r.id === 'dead').status).toBe('sent')
  })

  it('reconciliation-rollup writes no snapshot for a deleted workspace’s projects', async () => {
    h.db = createFakeSupabase({
      projects: [
        { id: 'p1', workspace_id: 'w1', contract_value: 1, status: 'Active', type: 'fixed', deleted_at: null, workspaces: { deleted_at: null } },
        { id: 'p2', workspace_id: 'w2', contract_value: 1, status: 'Active', type: 'fixed', deleted_at: null, workspaces: { deleted_at: ago(1) } },
      ],
    })
    const { body } = await call(rollup)
    expect(body.projectsProcessed).toBe(1)
    expect((h.db.tables.contract_reconciliation_snapshots || []).map((r: Row) => r.project_id)).toEqual(['p1'])
  })
})

describe('B2 — a downgrade never overwrites a plan a concurrent switch just set', () => {
  const ws = (over: Row = {}) => ({ id: 'w1', agency_name: 'A', plan_tier: 'pro', deleted_at: null, created_by: 'u1', creator: null, ...over })

  it('grace enforcement: a plan switch that lands mid-run keeps the NEW tier (the old revert restored the stale one)', async () => {
    h.db = createFakeSupabase({
      billing: [{ workspace_id: 'w1', grace_period_started_at: ago(6), paystack_subscription_code: 'OLD', paystack_email_token: 't', workspaces: ws() }],
      workspaces: [{ id: 'w1', plan_tier: 'pro' }],
    })
    h.cancelImpl = async () => {
      // webhook: new subscription + new plan land while the cancel call is in flight
      h.db.tables.billing[0].paystack_subscription_code = 'NEW'
      h.db.tables.workspaces[0].plan_tier = 'business'
      return { ok: true }
    }
    await call(paymentOverdue)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('business')
    expect(h.db.tables.billing[0].paystack_subscription_code).toBe('NEW')
  })

  it('grace enforcement: plan changed after the row was read (no subscription race) → not downgraded, no audit row', async () => {
    h.db = createFakeSupabase({
      billing: [{ workspace_id: 'w1', grace_period_started_at: ago(6), paystack_subscription_code: null, workspaces: ws() }],
      workspaces: [{ id: 'w1', plan_tier: 'business' }], // row read said 'pro'
    })
    await call(paymentOverdue)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('business')
    expect((h.db.tables.audit_log || []).some((r: Row) => r.event_type === 'billing.downgraded_for_nonpayment')).toBe(false)
  })

  it('grace enforcement: the normal case still downgrades and audits', async () => {
    h.db = createFakeSupabase({
      billing: [{ workspace_id: 'w1', grace_period_started_at: ago(6), paystack_subscription_code: null, workspaces: ws() }],
      workspaces: [{ id: 'w1', plan_tier: 'pro' }],
    })
    await call(paymentOverdue)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('solo')
    expect(h.db.tables.audit_log.some((r: Row) => r.event_type === 'billing.downgraded_for_nonpayment')).toBe(true)
  })

  it('cancelled-subscription sweep: downgrades normally, but never flattens a plan changed in between', async () => {
    const billing = (): Row => ({
      workspace_id: 'w1', cancels_at_period_end: true, current_period_end: ago(1), paystack_subscription_code: 'S', paystack_customer_code: 'C',
      workspaces: ws(),
    })
    h.db = createFakeSupabase({ billing: [billing()], workspaces: [{ id: 'w1', plan_tier: 'pro' }] })
    const ok = await call(paymentOverdue)
    expect(ok.body.cancelledSubscriptionsEnded).toBe(1)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('solo')

    h.db = createFakeSupabase({ billing: [billing()], workspaces: [{ id: 'w1', plan_tier: 'business' }] })
    const changed = await call(paymentOverdue)
    expect(changed.body.cancelledSubscriptionsEnded).toBe(0)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('business')
  })
})

describe('B3 — approval-stall withholds the no-approver alert when its dedupe marker cannot be written', () => {
  const req = (): Row => ({ id: 'r1', workspace_id: 'w1', project_id: 'p1', document_type: 'sow', status: 'pending', sending_started_at: null, updated_at: ago(10), reminder_count: 0, escalated_at: null, workspaces: { deleted_at: null } })

  it('does not notify when audit_log is failing (it used to re-alert every day)', async () => {
    h.reminder = 'no_recipients'; h.auditOk = false
    h.db = createFakeSupabase({ approval_requests: [req()] })
    const { body } = await call(approvalStall)
    expect(h.notified).toHaveLength(0)
    expect(body.escalated).toBe(0)
    expect(body.rowErrors?.join(' ')).toMatch(/dedupe marker/)
  })

  it('notifies once when the marker lands', async () => {
    h.reminder = 'no_recipients'
    h.db = createFakeSupabase({ approval_requests: [req()] })
    const { body } = await call(approvalStall)
    expect(h.notified).toHaveLength(1)
    expect(body.escalated).toBe(1)
  })
})
