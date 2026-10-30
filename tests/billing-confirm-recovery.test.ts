// tests/billing-confirm-recovery.test.ts
//
// Billing — payment stuck on "Payment received — confirming your plan". The plan only ever changed on Paystack's
// webhook, so a payment whose webhook never arrived stranded a paying customer. recoverPaidCheckout() verifies the
// payment with Paystack and applies it through the same handler. These tests pin: it applies a verified payment for
// THIS workspace's open checkout; it refuses anything it cannot tie to that checkout; and it is idempotent.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, audits: [] as any[],
  tx: null as any, subs: null as any, cancelled: [] as string[],
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/email/templates', () => ({ sendPaymentFailedEmail: async () => ({ ok: true }), sendCardExpiringEmail: async () => ({ ok: true }) }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/billing/limits', () => ({ measurePlanFit: async () => ({ ok: false, error: 'skipped' }) }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async (b: any) => { h.cancelled.push(b.paystack_subscription_code); return { ok: true } },
  fetchPaystackNextPaymentDate: async () => null,
  verifyPaystackTransaction: async () => h.tx,
  listPaystackSubscriptionsForCustomer: async () => h.subs,
}))

import { recoverPaidCheckout } from '@/lib/billing/recover-checkout'

process.env.PAYSTACK_SECRET_KEY = 'sk_recover'
process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'

const EMAIL = 'owner@agency.test'
const okTx = (over: Record<string, unknown> = {}) => ({ ok: true, tx: {
  status: 'success', reference: 'ref_1', amount: 2500, currency: 'USD', paidAt: '2026-10-30T10:00:00Z', channel: 'card',
  email: EMAIL, customerCode: 'CUS_1', customerId: 11, planCode: 'PLN_sm', planId: 5,
  metadata: { workspaceId: 'wA' }, authorization: { authorization_code: 'AUTH_1', last4: '4242', card_type: 'visa' }, ...over,
} })
const okSubs = (items: any[] = [{ subscriptionCode: 'SUB_NEW', emailToken: 'tok', status: 'active', nextPaymentDate: '2099-01-01T00:00:00Z', planCode: 'PLN_sm', customerCode: 'CUS_1', createdAt: '2026-10-30T10:00:01Z' }]) => ({ ok: true, subs: items })
const seed = (extra: Record<string, any[]> = {}) => createFakeSupabase({
  workspaces: [{ id: 'wA', plan_tier: 'solo', trial_ends_at: '2026-07-30T00:00:00Z', lapsed_at: '2026-07-30T00:00:00Z', deleted_at: null, agency_name: 'Acme' }],
  billing: [],
  billing_checkouts: [{ id: 'c1', workspace_id: 'wA', email: EMAIL, plan_key: 'solo', plan_interval: 'monthly', plan_code: 'PLN_sm', created_at: new Date().toISOString(), consumed_at: null }],
  processed_webhook_events: [],
  ...extra,
})

beforeEach(() => {
  h.audits.length = 0; h.cancelled.length = 0
  h.tx = okTx(); h.subs = okSubs()
  h.db = seed()
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const ws = () => h.db.tables?.workspaces?.[0] ?? h.db.data?.workspaces?.[0]

describe('recoverPaidCheckout', () => {
  it('applies a verified payment for this workspace: plan active, lapse cleared, subscription on file, checkout consumed', async () => {
    const r = await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')
    expect(r.state).toBe('applied')
    const { data: w } = await h.db.client.from('workspaces').select('plan_tier, lapsed_at, trial_ends_at').eq('id', 'wA').maybeSingle()
    expect(w.plan_tier).toBe('solo'); expect(w.lapsed_at).toBeNull(); expect(w.trial_ends_at).toBeNull()
    const { data: b } = await h.db.client.from('billing').select('paystack_subscription_code, plan_interval').eq('workspace_id', 'wA').maybeSingle()
    expect(b.paystack_subscription_code).toBe('SUB_NEW'); expect(b.plan_interval).toBe('monthly')
    const { data: open } = await h.db.client.from('billing_checkouts').select('id').eq('workspace_id', 'wA').is('consumed_at', null)
    expect(open).toHaveLength(0)
    expect(h.audits.map(a => a.eventType)).toEqual(expect.arrayContaining(['billing.payment_succeeded', 'billing.plan_changed']))
  })

  it('running it again (or after the real webhook) is a no-op that still reports applied', async () => {
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('applied')
    const n = h.audits.length
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('applied')
    expect(h.audits.length).toBe(n)
  })

  it('does not apply a payment Paystack reports as not successful', async () => {
    h.tx = okTx({ status: 'abandoned' })
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('payment_not_successful')
    const { data: b } = await h.db.client.from('billing').select('workspace_id').eq('workspace_id', 'wA')
    expect(b).toHaveLength(0)
  })

  it('refuses a reference whose popup metadata names another workspace', async () => {
    h.tx = okTx({ metadata: { workspaceId: 'wOther' } })
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('not_ours')
  })

  it('refuses when this workspace has no open checkout for that email + plan (and nothing is applied)', async () => {
    h.db = seed({ billing_checkouts: [{ id: 'c9', workspace_id: 'wB', email: EMAIL, plan_code: 'PLN_sm', created_at: new Date().toISOString(), consumed_at: null }] })
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('not_ours')
  })

  it('refuses an expired checkout', async () => {
    h.db = seed({ billing_checkouts: [{ id: 'c1', workspace_id: 'wA', email: EMAIL, plan_code: 'PLN_sm', created_at: new Date(Date.now() - 48 * 3600_000).toISOString(), consumed_at: null }] })
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('not_ours')
  })

  it('says subscription_pending (and applies nothing) while Paystack has not created the subscription yet', async () => {
    h.subs = okSubs([])
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('subscription_pending')
    const { data: b } = await h.db.client.from('billing').select('workspace_id').eq('workspace_id', 'wA')
    expect(b).toHaveLength(0)
  })

  it('ignores a subscription for a different plan code', async () => {
    h.subs = okSubs([{ subscriptionCode: 'SUB_X', status: 'active', planCode: 'PLN_other', createdAt: '2026-10-30T10:00:01Z' }])
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('subscription_pending')
  })

  it('reports unavailable (not a false success) when Paystack cannot be read', async () => {
    h.tx = { ok: false, notFound: false, error: 'timeout' }
    expect((await recoverPaidCheckout(h.db.client, 'wA', 'ref_1')).state).toBe('unavailable')
  })

  it('rejects a malformed reference without calling Paystack', async () => {
    expect((await recoverPaidCheckout(h.db.client, 'wA', '../../x')).state).toBe('not_ours')
    expect((await recoverPaidCheckout(h.db.client, 'wA', undefined)).state).toBe('not_ours')
  })
})
