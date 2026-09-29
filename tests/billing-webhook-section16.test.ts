// tests/billing-webhook-section16.test.ts
//
// Billing independent pass — webhook fixes:
//   B2  a failed audit write on a ledger event used to be discarded (the payment vanished from Payment history);
//   B3  a late event for an ENDED subscription used to start a fresh grace period on a Solo workspace;
//   B4  two workspaces of one login with open checkouts for the same plan made a paid subscription "ambiguous";
//   B6  refund.failed is now a row the history can show.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, audits: [] as any[], emails: [] as any[], alerts: [] as any[],
  auditOk: true, sha: null as any,
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { if (!h.auditOk) return false; h.audits.push(p); return true } }))
vi.mock('@/lib/email/templates', () => ({
  sendPaymentFailedEmail: async (p: any) => { h.emails.push(p); return { ok: true } },
  sendCardExpiringEmail: async (p: any) => { h.emails.push(p); return { ok: true } },
}))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async (_s: any, _w: string, extra: any[]) => extra.filter((e: any) => e.email).map((e: any) => ({ name: 'Owner', email: e.email })) }))
vi.mock('@/lib/billing/ops-alert', () => ({
  alertBillingOps: async (_s: any, key: string, subject: string, lines: string[]) => { h.alerts.push({ key, subject, lines }); return true },
}))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => ({ ok: true }),
  fetchPaystackNextPaymentDate: async () => null,
}))

import { POST } from '@/app/api/billing/webhook/route'
import { createHmac } from 'crypto'

process.env.PAYSTACK_SECRET_KEY = 'sk_test_section16'
process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

const EMAIL = 'owner@agency.test'
const future = new Date(Date.now() + 20 * 86_400_000).toISOString()
const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
const checkout = (ws: string, over: Row = {}): Row => ({
  id: `c_${ws}`, workspace_id: ws, user_id: 'u', email: EMAIL, plan_key: 'solo', plan_interval: 'monthly',
  plan_code: 'PLN_sm', created_at: new Date().toISOString(), consumed_at: null, ...over,
})
const workspaces = (): Row[] => [
  { id: 'wA', plan_tier: 'trial', deleted_at: null, agency_name: 'A' },
  { id: 'wB', plan_tier: 'trial', deleted_at: null, agency_name: 'B' },
]
const charge = (ws: string, ref: string, auth = `AUTH_${ws}`) => ({ event: 'charge.success', data: {
  reference: ref, amount: 2500, currency: 'USD', customer: { email: EMAIL, customer_code: 'CUS_1' },
  plan: { plan_code: 'PLN_sm' }, metadata: { workspaceId: ws }, authorization: { authorization_code: auth, last4: '4242', card_type: 'visa' },
} })
const subCreate = (code: string, auth?: string) => ({ event: 'subscription.create', data: {
  subscription_code: code, email_token: 'tok', next_payment_date: future,
  customer: { email: EMAIL, customer_code: 'CUS_1' }, plan: { plan_code: 'PLN_sm' },
  authorization: auth ? { authorization_code: auth } : undefined,
} })
const failed = (code?: string, ref?: string) => ({ event: 'invoice.payment_failed', data: {
  amount: 2500, currency: 'USD', reference: ref, customer: { email: EMAIL, customer_code: 'CUS_1' },
  subscription: code ? { subscription_code: code } : undefined,
} })

const send = async (ev: any) => {
  const raw = JSON.stringify(ev)
  const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex')
  const res: any = await POST({ text: async () => raw, headers: { get: (n: string) => (n.toLowerCase() === 'x-paystack-signature' ? sig : null) } } as any)
  return { status: res.status as number, body: await res.json() }
}
const table = (t: string): Row[] => h.db.tables[t] || []
const ws = (id: string) => table('workspaces').find(w => w.id === id)!

beforeEach(() => {
  h.audits.length = 0; h.emails.length = 0; h.alerts.length = 0; h.auditOk = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('B4 — two workspaces with an open checkout for the same plan', () => {
  it('charge.success stamps the paid checkout, so subscription.create applies it to the right workspace', async () => {
    h.db = createFakeSupabase({ workspaces: workspaces(), billing: [], billing_checkouts: [checkout('wA', { created_at: hourAgo }), checkout('wB')] })
    expect((await send(charge('wB', 'ref1'))).status).toBe(200)
    expect(table('billing_checkouts').find(c => c.workspace_id === 'wB')!.charged_at).toBeTruthy()
    expect(table('billing_checkouts').find(c => c.workspace_id === 'wA')!.charged_at).toBeFalsy()
    expect((await send(subCreate('SUB_1'))).status).toBe(200)
    expect(table('billing').map(b => [b.workspace_id, b.paystack_subscription_code])).toEqual([['wB', 'SUB_1']])
    expect(ws('wB').plan_tier).toBe('solo')
    expect(ws('wA').plan_tier).toBe('trial')
    expect(h.alerts.length).toBe(0)
  })

  it('subscription.create arriving BEFORE charge.success fails (so Paystack redelivers) instead of being silently dropped', async () => {
    h.db = createFakeSupabase({ workspaces: workspaces(), billing: [], billing_checkouts: [checkout('wA', { created_at: hourAgo }), checkout('wB')] })
    const sub = subCreate('SUB_2')
    expect((await send(sub)).status).toBe(500)
    expect(table('billing').length).toBe(0)
    expect(table('processed_webhook_events').length).toBe(0)     // claim released -> the redelivery re-runs
    await send(charge('wB', 'ref2'))
    expect((await send(sub)).status).toBe(200)
    expect(table('billing')[0].workspace_id).toBe('wB')
  })

  it('when BOTH were charged, the card authorization on the subscription picks the workspace', async () => {
    h.db = createFakeSupabase({ workspaces: workspaces(), billing: [], billing_checkouts: [checkout('wA'), checkout('wB')] })
    await send(charge('wA', 'rA', 'AUTH_A')); await send(charge('wB', 'rB', 'AUTH_B'))
    expect((await send(subCreate('SUB_3', 'AUTH_A'))).status).toBe(200)
    expect(table('billing')[0].workspace_id).toBe('wA')
  })

  it('when BOTH were charged and nothing tells them apart it is a real ambiguity: a human is paged, no endless retry', async () => {
    h.db = createFakeSupabase({ workspaces: workspaces(), billing: [], billing_checkouts: [checkout('wA'), checkout('wB')] })
    await send(charge('wA', 'rA', 'AUTH_A')); await send(charge('wB', 'rB', 'AUTH_B'))
    expect((await send(subCreate('SUB_4'))).status).toBe(200)
    expect(table('billing').length).toBe(0)
    expect(h.alerts.length).toBeGreaterThan(0)
  })
})

describe('B2 — the payment ledger row must not be lost', () => {
  const liveBilling = (): Row => ({ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_A', cancels_at_period_end: false, grace_period_started_at: null })
  const renewal = { event: 'charge.success', data: {
    reference: 'r9', amount: 2500, currency: 'USD', customer: { email: EMAIL, customer_code: 'CUS_1' },
    subscription: { subscription_code: 'SUB_A' }, plan: { plan_code: 'PLN_sm' },
  } }

  it('a failed audit write on charge.success is retried by Paystack and lands on redelivery', async () => {
    h.db = createFakeSupabase({ workspaces: [{ ...workspaces()[0], plan_tier: 'solo' }], billing: [liveBilling()], billing_checkouts: [] })
    h.auditOk = false
    expect((await send(renewal)).status).toBe(500)
    expect(h.alerts.some(a => a.subject.includes('audit row'))).toBe(true)
    expect(table('processed_webhook_events').length).toBe(0)
    h.auditOk = true
    expect((await send(renewal)).status).toBe(200)
    expect(h.audits.some(a => a.eventType === 'billing.payment_succeeded' && a.metadata.reference === 'r9')).toBe(true)
  })

  it('a failed audit write on subscription.create still applies the plan and pages ops (a redelivery could not re-write it)', async () => {
    h.db = createFakeSupabase({ workspaces: workspaces(), billing: [], billing_checkouts: [checkout('wA')] })
    h.auditOk = false
    expect((await send(subCreate('SUB_5'))).status).toBe(200)
    expect(table('billing')[0].paystack_subscription_code).toBe('SUB_5')
    expect(h.alerts.some(a => a.subject.includes('audit row'))).toBe(true)
  })
})

describe('B3 — late events for an ended subscription', () => {
  const ended = (): Row => ({ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: null, cancels_at_period_end: false, grace_period_started_at: null })
  const solo = () => [{ ...workspaces()[0], plan_tier: 'solo' }]

  it('a payment_failed naming a dead subscription does not start a grace period, email or audit', async () => {
    h.db = createFakeSupabase({ workspaces: solo(), billing: [ended()] })
    expect((await send(failed('SUB_dead'))).status).toBe(200)
    expect(table('billing')[0].grace_period_started_at ?? null).toBeNull()
    expect(h.emails.length).toBe(0)
    expect(h.audits.length).toBe(0)
  })

  it('...and neither does one whose payload names no subscription at all', async () => {
    h.db = createFakeSupabase({ workspaces: solo(), billing: [ended()] })
    expect((await send(failed())).status).toBe(200)
    expect(table('billing')[0].grace_period_started_at ?? null).toBeNull()
    expect(h.emails.length).toBe(0)
  })

  it('several ended workspaces + a late event: ignored quietly, ops is NOT paged', async () => {
    h.db = createFakeSupabase({ workspaces: workspaces(), billing: [ended(), { ...ended(), workspace_id: 'wB' }] })
    expect((await send(failed('SUB_dead'))).status).toBe(200)
    expect(h.alerts.length).toBe(0)
    expect(h.emails.length).toBe(0)
  })

  it('a failure on a LIVE subscription still starts grace once and emails once; a retry does not push the clock', async () => {
    h.db = createFakeSupabase({ workspaces: solo(), billing: [{ ...ended(), paystack_subscription_code: 'SUB_A' }] })
    await send(failed('SUB_A', 'r1'))
    const started = table('billing')[0].grace_period_started_at
    expect(started).toBeTruthy()
    expect(h.emails.length).toBe(1)
    expect(h.audits[0].eventType).toBe('billing.payment_failed_grace_started')
    await send(failed('SUB_A', 'r2'))
    expect(table('billing')[0].grace_period_started_at).toBe(started)
    expect(h.emails.length).toBe(1)
    expect(h.audits[1].eventType).toBe('billing.payment_retry_failed')
  })

  it('an audit failure after the dunning email does not re-send the email on redelivery', async () => {
    h.db = createFakeSupabase({ workspaces: solo(), billing: [{ ...ended(), paystack_subscription_code: 'SUB_A' }] })
    h.auditOk = false
    const ev = failed('SUB_A', 'r1')
    expect((await send(ev)).status).toBe(500)
    expect(h.emails.length).toBe(1)
    h.auditOk = true
    expect((await send(ev)).status).toBe(200)
    expect(h.emails.length).toBe(1)
    expect(h.audits.length).toBe(1)
  })
})

describe('B6 — refund.failed', () => {
  it('is written as billing.refund_failed (which Payment history now includes)', async () => {
    h.db = createFakeSupabase({ workspaces: workspaces(), billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_A' }] })
    const r = await send({ event: 'refund.failed', data: {
      amount: 2500, currency: 'USD', customer: { email: EMAIL, customer_code: 'CUS_1' },
      subscription: { subscription_code: 'SUB_A' }, transaction_reference: 'tr1',
    } })
    expect(r.status).toBe(200)
    expect(h.audits[0].eventType).toBe('billing.refund_failed')
  })
})
