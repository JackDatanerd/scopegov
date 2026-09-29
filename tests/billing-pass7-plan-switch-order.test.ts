// Billing independent pass 7 — B2: on a plan switch the NEW billing row must be written BEFORE the old subscription
// is disabled, so the disable webhook Paystack fires for the old code is ignored as superseded instead of being
// recorded as a real cancellation.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, audits: [] as any[], alerts: [] as any[], cancelImpl: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/email/templates', () => ({ sendPaymentFailedEmail: async () => ({ ok: true }), sendCardExpiringEmail: async () => ({ ok: true }) }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async (_s: any, key: string, subject: string) => { h.alerts.push({ key, subject }); return true } }))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async (b: any) => h.cancelImpl(b), fetchPaystackNextPaymentDate: async () => null }))

import { POST } from '@/app/api/billing/webhook/route'
import { createHmac } from 'crypto'
process.env.PAYSTACK_SECRET_KEY = 'sk_pass7'
process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'

const EMAIL = 'o@a.test'
const future = new Date(Date.now() + 20 * 86_400_000).toISOString()
const send = async (ev: any) => {
  const raw = JSON.stringify(ev)
  const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex')
  const res: any = await POST({ text: async () => raw, headers: { get: (n: string) => (n.toLowerCase() === 'x-paystack-signature' ? sig : null) } } as any)
  return res.status as number
}
const subCreate = { event: 'subscription.create', data: { subscription_code: 'SUB_NEW', email_token: 'tk', next_payment_date: future, customer: { email: EMAIL, customer_code: 'CUS_1' }, plan: { plan_code: 'PLN_sm' } } }
const seed = () => createFakeSupabase({
  workspaces: [{ id: 'wA', plan_tier: 'pro', deleted_at: null }],
  billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_OLD', paystack_email_token: 't', cancels_at_period_end: false, current_period_end: future, plan_interval: 'monthly' }],
  billing_checkouts: [{ id: 'c1', workspace_id: 'wA', user_id: 'u', email: EMAIL, plan_key: 'solo', plan_interval: 'monthly', plan_code: 'PLN_sm', created_at: new Date().toISOString(), consumed_at: null }],
})
const bill = () => h.db.tables.billing[0]
const pending = () => h.db.tables.billing_pending_subscription_cancels || []

beforeEach(() => {
  h.audits.length = 0; h.alerts.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('B2 — plan switch ordering', () => {
  it('the old code\'s disable webhook (fired by our own disable call) is ignored: no false cancellation row, flag stays false', async () => {
    h.db = seed()
    let disableStatus = 0
    h.cancelImpl = async () => {
      disableStatus = await send({ event: 'subscription.disable', data: { subscription_code: 'SUB_OLD', customer: { email: EMAIL, customer_code: 'CUS_1' } } })
      return { ok: true, alreadyCancelled: false }
    }
    expect(await send(subCreate)).toBe(200)
    expect(disableStatus).toBe(200)
    expect(bill().paystack_subscription_code).toBe('SUB_NEW')
    expect(bill().cancels_at_period_end).toBe(false)
    expect(h.audits.map(a => a.metadata.action)).toEqual(['subscription_created'])
    expect(h.audits[0].metadata.previous_subscription_disabled).toBe(true)
    expect(pending().length).toBe(0)
  })

  it('the new row is already on file at the moment the old subscription is disabled', async () => {
    h.db = seed()
    let codeAtDisable: string | null = null
    h.cancelImpl = async () => { codeAtDisable = bill().paystack_subscription_code; return { ok: true } }
    await send(subCreate)
    expect(codeAtDisable).toBe('SUB_NEW')
  })

  it('a failed disable is alerted and stays queued for the daily retry (nothing lost)', async () => {
    h.db = seed()
    h.cancelImpl = async () => ({ ok: false, error: 'paystack down' })
    expect(await send(subCreate)).toBe(200)
    expect(bill().paystack_subscription_code).toBe('SUB_NEW')
    expect(pending().map((p: any) => p.subscription_code)).toEqual(['SUB_OLD'])
    expect(h.alerts.some(a => a.subject.includes('NOT disabled'))).toBe(true)
    expect(h.audits[0].metadata.previous_subscription_cancel_pending_retry).toBe(true)
  })

  it('a crash after the row swap but before the disable still leaves the old subscription queued', async () => {
    h.db = seed()
    h.cancelImpl = async () => { throw new Error('function killed') }
    expect(await send(subCreate)).toBe(500)          // claim released -> Paystack redelivers
    expect(bill().paystack_subscription_code).toBe('SUB_NEW')
    expect(pending().map((p: any) => p.subscription_code)).toEqual(['SUB_OLD'])
  })
})
