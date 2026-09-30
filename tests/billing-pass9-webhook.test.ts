// tests/billing-pass9-webhook.test.ts
//
// Billing independent pass 9 — B1 (webhook subscription.not_renew / subscription.disable).
// A cancellation arriving from Paystack (manage link / email) must not be recorded against a missing or
// already-elapsed current_period_end: payment-overdue step 5 would downgrade a customer who just renewed,
// or (NULL date) never end the subscription at all.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, audits: [] as any[], fetched: null as string | null, fetchThrows: false, fetchCalls: 0,
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/email/templates', () => ({
  sendPaymentFailedEmail: async () => ({ ok: true }),
  sendCardExpiringEmail: async () => ({ ok: true }),
}))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => ({ ok: true }),
  fetchPaystackNextPaymentDate: async () => {
    h.fetchCalls++
    if (h.fetchThrows) throw new Error('paystack down')
    return h.fetched
  },
}))

import { POST } from '@/app/api/billing/webhook/route'
import { createHmac } from 'crypto'

process.env.PAYSTACK_SECRET_KEY = 'sk_test_pass9'
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

const DAY = 86400000
const past = () => new Date(Date.now() - 2 * DAY).toISOString()
const future = (days = 20) => new Date(Date.now() + days * DAY).toISOString()

const ev = (event: string, extra: Record<string, any> = {}) => ({ event, data: {
  subscription_code: 'SUB_A', customer: { email: 'owner@agency.test', customer_code: 'CUS_1' }, ...extra,
} })
const send = async (e: any) => {
  const raw = JSON.stringify(e)
  const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex')
  const res: any = await POST({ text: async () => raw, headers: { get: (n: string) => (n.toLowerCase() === 'x-paystack-signature' ? sig : null) } } as any)
  return { status: res.status as number, body: await res.json() }
}
const seed = (periodEnd: string | null) => createFakeSupabase({
  workspaces: [{ id: 'wA', plan_tier: 'pro', deleted_at: null, agency_name: 'Acme' }],
  billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_A',
    cancels_at_period_end: false, grace_period_started_at: null, current_period_end: periodEnd } as Row],
})

beforeEach(() => {
  h.audits.length = 0; h.fetched = null; h.fetchThrows = false; h.fetchCalls = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('subscription.not_renew / disable — current_period_end is refreshed with the flag (pass 9 B1)', () => {
  it('an elapsed stored date is replaced by the event\'s future next_payment_date', async () => {
    h.db = seed(past())
    const np = future(30)
    const r = await send(ev('subscription.not_renew', { next_payment_date: np }))
    expect(r.status).toBe(200)
    const b = h.db.tables.billing[0]
    expect(b.cancels_at_period_end).toBe(true)
    expect(b.current_period_end).toBe(np)
    expect(h.fetchCalls).toBe(0)
    expect(h.audits[0].metadata.ends_at).toBe(np)
  })

  it('a missing stored date is filled from Paystack when the event carries none', async () => {
    h.db = seed(null)
    h.fetched = future(25)
    const r = await send(ev('subscription.disable'))
    expect(r.status).toBe(200)
    const b = h.db.tables.billing[0]
    expect(b.cancels_at_period_end).toBe(true)
    expect(b.current_period_end).toBe(h.fetched)
    expect(h.audits[0].metadata.ends_at).toBe(h.fetched)
  })

  it('an elapsed stored date with no usable date anywhere keeps the old behaviour (flag set, date untouched)', async () => {
    const old = past()
    h.db = seed(old)
    h.fetched = null
    const r = await send(ev('subscription.not_renew'))
    expect(r.status).toBe(200)
    const b = h.db.tables.billing[0]
    expect(b.cancels_at_period_end).toBe(true)
    expect(b.current_period_end).toBe(old)
  })

  it('a past date from the event or from Paystack is never written', async () => {
    const old = past()
    h.db = seed(old)
    h.fetched = past()
    const r = await send(ev('subscription.not_renew', { next_payment_date: past() }))
    expect(r.status).toBe(200)
    expect(h.db.tables.billing[0].current_period_end).toBe(old)
  })

  it('a failing Paystack read is non-fatal', async () => {
    h.db = seed(null)
    h.fetchThrows = true
    const r = await send(ev('subscription.not_renew'))
    expect(r.status).toBe(200)
    expect(h.db.tables.billing[0].cancels_at_period_end).toBe(true)
  })

  it('a valid stored future date is left alone and Paystack is not called', async () => {
    const keep = future(10)
    h.db = seed(keep)
    h.fetched = future(40)
    const r = await send(ev('subscription.not_renew', { next_payment_date: future(50) }))
    expect(r.status).toBe(200)
    const b = h.db.tables.billing[0]
    expect(b.cancels_at_period_end).toBe(true)
    expect(b.current_period_end).toBe(keep)
    expect(h.fetchCalls).toBe(0)
  })
})
