import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, audits: [] as any[], notified: [] as any[], alerts: [] as any[], heartbeats: [] as any[],
  reminder: {} as Record<string, string>, paystack: {} as Record<string, any>, emails: [] as any[],
}))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async (...a: any[]) => { h.alerts.push(a) } }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async (_s: any, name: string, r: any) => { h.heartbeats.push({ name, r }) } }))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ id: `a${h.db.tables.audit_log.length}`, created_at: new Date().toISOString(), ...row }); h.audits.push(row); return true },
}))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async (_s: any, p: any) => { h.notified.push(p) } }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => ['a@b.test'] }))
vi.mock('@/lib/email/templates', () => ({ sendGuardianFlagStalledEmail: async (p: any) => { h.emails.push(p) } }))
vi.mock('@/lib/approvals/engine', () => ({
  healStuckSends: async () => [],
  documentLabelFor: (t: string) => t,
  sendApprovalReminder: async (_s: any, id: string) => h.reminder[id] ?? 'sent',
}))
vi.mock('@/lib/integrations/paystack', () => ({ fetchPaystackSubscription: async (code: string) => h.paystack[code] ?? { ok: false, notFound: false, error: 'no fixture' } }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => {} }))

import { POST as approvalStall } from '@/app/api/cron/approval-stall/route'
import { POST as billingReconcile } from '@/app/api/cron/billing-reconcile/route'
import { POST as flagStall } from '@/app/api/cron/guardian-flag-stall/route'

const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const call = async (fn: any) => { const res = await fn({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  h.audits.length = 0; h.notified.length = 0; h.alerts.length = 0; h.heartbeats.length = 0; h.emails.length = 0
  h.reminder = {}; h.paystack = {}
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

// ── approval-stall ──────────────────────────────────────────────────────────────────────────────
const req = (over: Row = {}) => ({ id: 'r1', workspace_id: 'w1', project_id: 'p1', document_type: 'sow', status: 'pending', sending_started_at: null, updated_at: ago(10), reminder_count: 0, escalated_at: null, ...over })

describe('cron/approval-stall', () => {
  it('reminds, counts the reminder, and escalates to admins exactly once at the third', async () => {
    h.db = createFakeSupabase({ approval_requests: [req({ reminder_count: 2 })] })
    const { body } = await call(approvalStall)
    expect(body.reminded).toBe(1); expect(body.unresponsiveEscalated).toBe(1)
    const row = h.db.tables.approval_requests[0]
    expect(row.reminder_count).toBe(3); expect(row.escalated_at).toBeTruthy()
    expect(h.notified.filter(n => n.type === 'approval_unresponsive')).toHaveLength(1)

    // stale again next window: reminded again, but NOT escalated a second time
    row.updated_at = ago(10)
    await call(approvalStall)
    expect(h.notified.filter(n => n.type === 'approval_unresponsive')).toHaveLength(1)
  })

  it('an earlier "no reachable approver" alert no longer blocks the unresponsive escalation (escalated_at meant both)', async () => {
    h.db = createFakeSupabase({
      approval_requests: [req({ reminder_count: 2, escalated_at: null })],
      audit_log: [{ id: 'x', workspace_id: 'w1', entity_id: 'r1', event_type: 'approval.no_reachable_approver', created_at: ago(2) }],
    })
    const { body } = await call(approvalStall)
    expect(body.unresponsiveEscalated).toBe(1)
  })

  it('the no-approver alert fires once, is deduped for a week on its OWN audit trail, and never touches escalated_at', async () => {
    h.reminder.r1 = 'no_recipients'
    h.db = createFakeSupabase({ approval_requests: [req()] })
    const first = await call(approvalStall)
    expect(first.body.escalated).toBe(1)
    expect(h.notified.filter(n => n.type === 'approval_no_reachable_approver')).toHaveLength(1)
    expect(h.db.tables.approval_requests[0].escalated_at).toBeNull()
    const second = await call(approvalStall)
    expect(second.body.escalated).toBe(0)
    expect(h.notified.filter(n => n.type === 'approval_no_reachable_approver')).toHaveLength(1)
  })

  it('re-alerts once the week is up', async () => {
    h.reminder.r1 = 'no_recipients'
    h.db = createFakeSupabase({
      approval_requests: [req()],
      audit_log: [{ id: 'x', workspace_id: 'w1', entity_id: 'r1', event_type: 'approval.no_reachable_approver', created_at: ago(8) }],
    })
    const { body } = await call(approvalStall)
    expect(body.escalated).toBe(1)
  })

  it('a failed bookkeeping write is reported (it used to re-remind the approver every run, silently)', async () => {
    h.db = createFakeSupabase({ approval_requests: [req()] }, { errors: [{ table: 'approval_requests', op: 'update', message: 'rls' }] })
    const { body } = await call(approvalStall)
    expect(body.rowErrors?.join(' ')).toMatch(/reminder bookkeeping failed/)
    expect(h.alerts).toHaveLength(1)
  })

  it("counts requests whose reminder target can't be found instead of dropping them silently", async () => {
    h.reminder.r1 = 'not_found'
    h.db = createFakeSupabase({ approval_requests: [req()] })
    const { body } = await call(approvalStall)
    expect(body.notFound).toBe(1)
  })
})

// ── billing-reconcile ───────────────────────────────────────────────────────────────────────────
const bill = (id: string, over: Row = {}) => ({ workspace_id: id, paystack_subscription_code: `SUB_${id}`, current_period_end: ago(-10), cancels_at_period_end: false, grace_period_started_at: null, last_reconciled_at: null, workspaces: { id, agency_name: `A ${id}`, deleted_at: null }, ...over })

describe('cron/billing-reconcile', () => {
  it('reports FAILURE (alert, 500, no heartbeat) when Paystack cannot be read for any subscription — it used to finish green', async () => {
    h.db = createFakeSupabase({ billing: [bill('w1'), bill('w2')] })
    h.paystack = { SUB_w1: { ok: false, notFound: false, error: 'Invalid key' }, SUB_w2: { ok: false, notFound: false, error: 'Invalid key' } }
    const { status, body } = await call(billingReconcile)
    expect(status).toBe(500)
    expect(body.errors.join(' ')).toMatch(/could not be read for any of the 2 subscriptions/)
    expect(body.errors.join(' ')).toMatch(/Invalid key/)
    expect(h.alerts).toHaveLength(1); expect(h.heartbeats).toHaveLength(0)
    expect(h.db.tables.billing.every((b: Row) => b.last_reconciled_at === null)).toBe(true) // retried tomorrow, not skipped
  })

  it('partial read failures are a row-level alert but keep the heartbeat; healthy rows are still reconciled', async () => {
    h.db = createFakeSupabase({ billing: [bill('w1'), bill('w2')] })
    h.paystack = { SUB_w1: { ok: true, sub: { status: 'active', nextPaymentDate: null } }, SUB_w2: { ok: false, notFound: false, error: 'timeout' } }
    const { status, body } = await call(billingReconcile)
    expect(status).toBe(200)
    expect(body.checked).toBe(1); expect(body.readErrors).toBe(1)
    expect(body.rowErrors?.join(' ')).toMatch(/1 of 2 subscription reads failed/)
    expect(h.alerts).toHaveLength(1); expect(h.heartbeats).toHaveLength(1)
    expect(h.db.tables.billing.find((b: Row) => b.workspace_id === 'w1').last_reconciled_at).toBeTruthy()
    expect(h.db.tables.billing.find((b: Row) => b.workspace_id === 'w2').last_reconciled_at).toBeNull()
  })

  it('repairs a subscription cancelled upstream and stamps the cursor', async () => {
    h.db = createFakeSupabase({ billing: [bill('w1')] })
    h.paystack = { SUB_w1: { ok: true, sub: { status: 'non-renewing', nextPaymentDate: null } } }
    const { body } = await call(billingReconcile)
    expect(body.repaired).toBe(1)
    expect(h.db.tables.billing[0]).toMatchObject({ cancels_at_period_end: true })
    expect(h.audits.map(a => a.event_type)).toContain('billing.reconciled')
  })

  it('a NOT FOUND subscription is an anomaly, still counts as a completed check, and is not a read failure', async () => {
    h.db = createFakeSupabase({ billing: [bill('w1')] })
    h.paystack = { SUB_w1: { ok: false, notFound: true, error: '404' } }
    const { status, body } = await call(billingReconcile)
    expect(status).toBe(200); expect(body.anomalies).toBe(1); expect(body.readErrors).toBe(0)
    expect(h.db.tables.billing[0].last_reconciled_at).toBeTruthy()
  })
})

// ── guardian-flag-stall ─────────────────────────────────────────────────────────────────────────
const flag = (id: string, project: Row, over: Row = {}) => ({ id, workspace_id: 'w1', project_id: 'p1', status: 'open', severity: 'high', description: 'd', updated_at: ago(9), projects: { id: 'p1', name: 'Acme', status: 'Active', deleted_at: null, clients: { name: 'Acme' }, ...project }, ...over })

describe('cron/guardian-flag-stall', () => {
  it('reminds on a stale open flag and bumps updated_at so it is not re-picked', async () => {
    h.db = createFakeSupabase({ guardian_flags: [flag('f1', {})] })
    const { body } = await call(flagStall)
    expect(body.reminded).toBe(1)
    expect(new Date(h.db.tables.guardian_flags[0].updated_at).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(h.notified).toHaveLength(1)
    const again = await call(flagStall)
    expect(again.body.reminded).toBe(0)
  })

  it('never reminds about flags on finished or deleted projects (and no longer even loads them)', async () => {
    h.db = createFakeSupabase({ guardian_flags: [
      flag('f1', { status: 'Complete' }), flag('f2', { status: 'Archived' }), flag('f3', { deleted_at: ago(1) }), flag('f4', {}, { updated_at: ago(1) }),
    ] })
    const { body } = await call(flagStall)
    expect(body.reminded).toBe(0)
  })

  it('a failing reminder bump is reported, not mistaken for "lost the race"', async () => {
    h.db = createFakeSupabase({ guardian_flags: [flag('f1', {})] }, { errors: [{ table: 'guardian_flags', op: 'update', message: 'rls' }] })
    const { body } = await call(flagStall)
    expect(body.reminded).toBe(0)
    expect(body.rowErrors?.join(' ')).toMatch(/reminder bump failed/)
    expect(h.alerts).toHaveLength(1)
  })
})
