// tests/billing-pass10-webhook.test.ts
//
// Billing independent pass 10 — api/billing/webhook:
//   B1  subscription.not_renew / disable with no future date from the event or Paystack falls back to an
//       estimate from recorded state (never an elapsed or missing date when a safe estimate exists)
//   B5  subscription.create records (and pages on) usage that grew past the new plan's limits during checkout

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, audits: [] as any[], alerts: [] as any[] }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/email/templates', () => ({ sendPaymentFailedEmail: async () => ({ ok: true }), sendCardExpiringEmail: async () => ({ ok: true }) }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async (_s: any, key: string, subject: string) => { h.alerts.push({ key, subject }); return true } }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => ({ ok: true }),
  fetchPaystackNextPaymentDate: async () => null,
}))

import { POST } from '@/app/api/billing/webhook/route'
import { addBillingInterval } from '@/lib/billing/period-end'
import { createHmac } from 'crypto'

process.env.PAYSTACK_SECRET_KEY = 'sk_pass10'
process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

const DAY = 86_400_000
const EMAIL = 'owner@agency.test'
const send = async (e: any) => {
  const raw = JSON.stringify(e)
  const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex')
  const res: any = await POST({ text: async () => raw, headers: { get: (n: string) => (n.toLowerCase() === 'x-paystack-signature' ? sig : null) } } as any)
  return res.status as number
}
const bill = () => h.db.tables.billing[0]

beforeEach(() => {
  h.audits.length = 0; h.alerts.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('B1 — subscription.not_renew with no future date anywhere', () => {
  const seed = (over: Row = {}, extra: Record<string, Row[]> = {}) => createFakeSupabase({
    workspaces: [{ id: 'wA', plan_tier: 'pro', deleted_at: null, agency_name: 'Acme' }],
    billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_A', cancels_at_period_end: false,
      grace_period_started_at: null, plan_interval: 'monthly', current_period_end: null, ...over }],
    ...extra,
  })
  const ev = { event: 'subscription.not_renew', data: { subscription_code: 'SUB_A', customer: { email: EMAIL, customer_code: 'CUS_1' } } }

  it('an elapsed stored date is rolled forward one interval', async () => {
    const stored = Date.now() - 3_600_000
    h.db = seed({ current_period_end: new Date(stored).toISOString() })
    expect(await send(ev)).toBe(200)
    const expected = new Date(addBillingInterval(stored, 'monthly')).toISOString()
    expect(bill().cancels_at_period_end).toBe(true)
    expect(bill().current_period_end).toBe(expected)
    expect(h.audits[0].metadata.ends_at).toBe(expected)
    expect(h.audits[0].metadata.period_end_estimated).toBe(true)
  })

  it('a missing stored date is anchored on the newest recorded payment', async () => {
    const paid = Date.now() - 9 * DAY
    h.db = seed({}, { audit_log: [{ workspace_id: 'wA', event_type: 'billing.payment_succeeded', created_at: new Date(paid).toISOString(), metadata: { paid_at: new Date(paid).toISOString() } }] })
    expect(await send(ev)).toBe(200)
    expect(bill().current_period_end).toBe(new Date(addBillingInterval(paid, 'monthly')).toISOString())
  })

  it('no estimate while a payment is failing: the date is left as it was', async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString()
    h.db = seed({ current_period_end: old, grace_period_started_at: new Date().toISOString() })
    expect(await send(ev)).toBe(200)
    expect(bill().cancels_at_period_end).toBe(true)
    expect(bill().current_period_end).toBe(old)
    expect(h.audits[0].metadata.period_end_estimated).toBeUndefined()
  })

  it('a date supplied by the event still wins over any estimate', async () => {
    const np = new Date(Date.now() + 30 * DAY).toISOString()
    h.db = seed({ current_period_end: new Date(Date.now() - 3_600_000).toISOString() })
    expect(await send({ ...ev, data: { ...ev.data, next_payment_date: np } })).toBe(200)
    expect(bill().current_period_end).toBe(np)
    expect(h.audits[0].metadata.period_end_estimated).toBeUndefined()
  })
})

describe('B5 — usage that outgrew the new plan during the checkout window', () => {
  const future = new Date(Date.now() + 20 * DAY).toISOString()
  const subCreate = { event: 'subscription.create', data: { subscription_code: 'SUB_NEW', email_token: 'tk', next_payment_date: future, customer: { email: EMAIL, customer_code: 'CUS_1' }, plan: { plan_code: 'PLN_sm' } } }
  const seed = (members: number, projects: number) => createFakeSupabase({
    workspaces: [{ id: 'wA', plan_tier: 'pro', deleted_at: null }],
    billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_OLD', paystack_email_token: 't', cancels_at_period_end: false, current_period_end: future, plan_interval: 'monthly' }],
    billing_checkouts: [{ id: 'c1', workspace_id: 'wA', user_id: 'u', email: EMAIL, plan_key: 'solo', plan_interval: 'monthly', plan_code: 'PLN_sm', created_at: new Date().toISOString(), consumed_at: null }],
    workspace_members: Array.from({ length: members }, (_, i) => ({ id: `m${i}`, workspace_id: 'wA', status: 'active' })),
    projects: Array.from({ length: projects }, (_, i) => ({ id: `p${i}`, workspace_id: 'wA', deleted_at: null, status: 'Active' })),
  })

  it('the payment is applied as normal, the overage is recorded in history and ops is paged', async () => {
    h.db = seed(3, 4) // Solo = 1 seat, 2 projects
    expect(await send(subCreate)).toBe(200)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('solo')
    expect(bill().paystack_subscription_code).toBe('SUB_NEW')
    expect(h.audits[0].metadata.over_limit).toEqual({ active_members: 3, seat_limit: 1, active_projects: 4, project_limit: 2 })
    expect(h.alerts.some(a => a.key.startsWith('billing:over-limit'))).toBe(true)
  })
  it('usage within the limits adds nothing', async () => {
    h.db = seed(1, 2)
    expect(await send(subCreate)).toBe(200)
    expect(h.audits[0].metadata.over_limit).toBeUndefined()
    expect(h.alerts.some(a => a.key.startsWith('billing:over-limit'))).toBe(false)
  })
  it('a failing usage read never fails (or re-runs) an applied payment', async () => {
    h.db = createFakeSupabase({
      workspaces: [{ id: 'wA', plan_tier: 'pro', deleted_at: null }],
      billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_OLD', paystack_email_token: 't', cancels_at_period_end: false, current_period_end: future, plan_interval: 'monthly' }],
      billing_checkouts: [{ id: 'c1', workspace_id: 'wA', user_id: 'u', email: EMAIL, plan_key: 'solo', plan_interval: 'monthly', plan_code: 'PLN_sm', created_at: new Date().toISOString(), consumed_at: null }],
    }, { errors: [{ table: 'workspace_members', op: 'select' }] })
    expect(await send(subCreate)).toBe(200)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('solo')
    expect(h.audits[0].metadata.over_limit).toBeUndefined()
  })
})
