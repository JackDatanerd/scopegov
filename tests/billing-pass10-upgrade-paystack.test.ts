// tests/billing-pass10-upgrade-paystack.test.ts
//
// Billing independent pass 10:
//   B5  api/billing/upgrade fails closed when it cannot count members/projects (a failed read used to count as 0)
//   (B3, the body-read timeout, is covered in paystack-integration.test.ts against the real module)
//   B1  cron/billing-reconcile repairs (or reports) a cancelling row that has no period end

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, audits: [] as any[], alerts: [] as any[], paystack: {} as Record<string, any> }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'owner@agency.test', name: 'Owner', workspaceId: 'w1', agencyName: 'Agency' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true, insertAuditRow: async (_s: any, r: any) => { h.audits.push(r); return true } }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async (_s: any, key: string, subject: string, lines: string[]) => { h.alerts.push({ key, subject, lines }); return true } }))
vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async () => {} }))
vi.mock('@/lib/utils/cron-run', () => ({
  CronRun: class {
    result: Record<string, unknown> = {}; errors: string[] = []
    constructor(_s: any, _n: string) {}
    rowError(l: string, e: any) { this.errors.push(`${l}: ${e?.message ?? e}`) }
    async step(_n: string, fn: () => Promise<void>) { try { await fn() } catch (e) { this.errors.push(String((e as any)?.message ?? e)) } }
    async finish() { return { body: { ...this.result, errors: this.errors }, status: 200 } }
  },
}))
vi.mock('@/lib/integrations/paystack', () => ({
  fetchPaystackSubscription: async (code: string) => h.paystack[code] ?? { ok: false, notFound: false, error: 'no fixture' },
}))

import { POST as upgrade } from '@/app/api/billing/upgrade/route'
import { POST as reconcile } from '@/app/api/cron/billing-reconcile/route'
import { addBillingInterval } from '@/lib/billing/period-end'
import { measurePlanFit } from '@/lib/billing/limits'

process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY = 'pk_test'
process.env.PAYSTACK_SECRET_KEY = 'sk_test'
process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'

const DAY = 86_400_000
const callUpgrade = async () => {
  const res: any = await upgrade({ json: async () => ({ planKey: 'solo', interval: 'monthly' }) } as any)
  return { status: res.status, body: await res.json() }
}
const base = (over: Record<string, Row[]> = {}) => ({
  workspaces: [{ id: 'w1', plan_tier: 'pro' }],
  billing: [{ workspace_id: 'w1', paystack_subscription_code: 'SUB_A', plan_interval: 'monthly', cancels_at_period_end: false, grace_period_started_at: null }],
  users: [{ id: 'u1', email: 'owner@agency.test' }],
  workspace_members: [{ id: 'm1', workspace_id: 'w1', status: 'active' }],
  projects: [{ id: 'p1', workspace_id: 'w1', deleted_at: null, status: 'Active' }],
  ...over,
})

beforeEach(() => {
  h.audits.length = 0; h.alerts.length = 0; h.paystack = {}
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('B5 — api/billing/upgrade fails closed on an unreadable usage count', () => {
  it('a failed member count is a 500, not "0 members" (and no checkout is recorded)', async () => {
    h.db = createFakeSupabase(base({ workspace_members: Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, workspace_id: 'w1', status: 'active' })) }),
      { errors: [{ table: 'workspace_members', op: 'select' }] })
    const r = await callUpgrade()
    expect(r.status).toBe(500)
    expect(h.db.tables.billing_checkouts || []).toHaveLength(0)
  })
  it('a failed project count is a 500 too', async () => {
    h.db = createFakeSupabase(base(), { errors: [{ table: 'projects', op: 'select' }] })
    expect((await callUpgrade()).status).toBe(500)
  })
  it('real over-limit usage is still refused with the same explanation', async () => {
    h.db = createFakeSupabase(base({ workspace_members: Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, workspace_id: 'w1', status: 'active' })) }))
    const r = await callUpgrade()
    expect(r.status).toBe(409)
    expect(r.body.seatLimitExceeded).toBe(true)
    expect(r.body.error).toMatch(/3 active members, more than the 1-seat limit on Solo/)
  })
  it('usage within the limits starts the checkout', async () => {
    h.db = createFakeSupabase(base())
    const r = await callUpgrade()
    expect(r.status).toBe(200)
    expect(r.body.planCode).toBe('PLN_sm')
    expect(h.db.tables.billing_checkouts).toHaveLength(1)
  })
  it('measurePlanFit skips the queries for a plan with no such limit', async () => {
    const db = createFakeSupabase(base(), { errors: [{ table: 'projects', op: 'select' }] })
    const r = await measurePlanFit(db.client, 'w1', 'pro') // Pro: unlimited projects
    expect(r.ok).toBe(true)
  })
})

describe('B1 — billing-reconcile: a cancelling row with no period end', () => {
  const row = (over: Row = {}) => ({
    workspace_id: 'w1', paystack_subscription_code: 'SUB_A', current_period_end: null, cancels_at_period_end: true,
    grace_period_started_at: null, plan_interval: 'monthly', last_reconciled_at: null,
    workspaces: { id: 'w1', agency_name: 'Acme', deleted_at: null, plan_tier: 'pro' }, ...over,
  })
  const call = async () => { const res: any = await reconcile({} as any); return res.status as number }

  it('fills it from the newest recorded payment (Paystack has no date for a cancelled subscription)', async () => {
    const paid = Date.now() - 8 * DAY
    h.db = createFakeSupabase({ billing: [row()], audit_log: [{ workspace_id: 'w1', event_type: 'billing.payment_succeeded', created_at: new Date(paid).toISOString(), metadata: { paid_at: new Date(paid).toISOString() } }] })
    h.paystack = { SUB_A: { ok: true, sub: { status: 'cancelled', nextPaymentDate: null, planCode: null } } }
    await call()
    expect(h.db.tables.billing[0].current_period_end).toBe(new Date(addBillingInterval(paid, 'monthly')).toISOString())
    expect(h.audits.some(a => a.event_type === 'billing.reconciled' && a.metadata.current_period_end.estimated === true)).toBe(true)
  })
  it('reports it when no estimate is possible', async () => {
    h.db = createFakeSupabase({ billing: [row()] })
    h.paystack = { SUB_A: { ok: true, sub: { status: 'cancelled', nextPaymentDate: null, planCode: null } } }
    await call()
    expect(h.db.tables.billing[0].current_period_end).toBeNull()
    expect(h.alerts.some(a => a.lines.join(' ').includes('NO current_period_end'))).toBe(true)
  })
  it('leaves a healthy cancelling row alone', async () => {
    const keep = new Date(Date.now() + 5 * DAY).toISOString()
    h.db = createFakeSupabase({ billing: [row({ current_period_end: keep })] })
    h.paystack = { SUB_A: { ok: true, sub: { status: 'cancelled', nextPaymentDate: null, planCode: null } } }
    await call()
    expect(h.db.tables.billing[0].current_period_end).toBe(keep)
    expect(h.alerts).toHaveLength(0)
  })
})
