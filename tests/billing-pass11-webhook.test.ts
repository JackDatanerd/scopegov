// tests/billing-pass11-webhook.test.ts
//
// Billing independent pass 11 — api/billing/webhook:
//   B2  every audit row the webhook writes asks logAudit NOT to stamp the ambient request IP (Paystack's egress IP)
//   B3  a re-run of charge.success (stale-claim takeover after a failed "mark done") does not write a second
//       billing.payment_succeeded row for the same charge reference

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, audits: [] as any[] }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/email/templates', () => ({ sendPaymentFailedEmail: async () => ({ ok: true }), sendCardExpiringEmail: async () => ({ ok: true }) }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => ({ ok: true }),
  fetchPaystackNextPaymentDate: async () => null,
}))

import { POST } from '@/app/api/billing/webhook/route'
import { createHmac } from 'crypto'

process.env.PAYSTACK_SECRET_KEY = 'sk_pass11'
process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

const EMAIL = 'owner@agency.test'
const send = async (e: any) => {
  const raw = JSON.stringify(e)
  const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex')
  const res: any = await POST({ text: async () => raw, headers: { get: (n: string) => (n.toLowerCase() === 'x-paystack-signature' ? sig : null) } } as any)
  return res.status as number
}
const charge = (ref: string) => ({ event: 'charge.success', data: {
  reference: ref, amount: 2500, currency: 'USD', customer: { email: EMAIL, customer_code: 'CUS_1' },
  plan: { plan_code: 'PLN_sm' }, authorization: { authorization_code: 'AUTH_1', last4: '4242', card_type: 'visa' },
} })
const seed = (extra: Record<string, Row[]> = {}, opts: any = {}) => createFakeSupabase({
  workspaces: [{ id: 'wA', plan_tier: 'solo', deleted_at: null, agency_name: 'Acme' }],
  billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_A', cancels_at_period_end: false, grace_period_started_at: null, plan_interval: 'monthly', current_period_end: null }],
  ...extra,
}, opts)
const paymentRows = () => h.audits.filter(a => a.eventType === 'billing.payment_succeeded')

beforeEach(() => {
  h.audits.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('B2 — webhook audit rows never carry the ambient request IP', () => {
  it('charge.success asks logAudit to omit the client IP', async () => {
    h.db = seed()
    expect(await send(charge('r1'))).toBe(200)
    expect(paymentRows()).toHaveLength(1)
    expect(paymentRows()[0].omitClientIp).toBe(true)
  })
  it('the other ledger rows do too (invoice.payment_failed)', async () => {
    h.db = seed()
    const ev = { event: 'invoice.payment_failed', data: { amount: 2500, currency: 'USD', customer: { email: EMAIL, customer_code: 'CUS_1' }, subscription: { subscription_code: 'SUB_A' } } }
    expect(await send(ev)).toBe(200)
    expect(h.audits.length).toBeGreaterThan(0)
    expect(h.audits.every(a => a.omitClientIp === true)).toBe(true)
  })
})

describe('B3 — a re-run of charge.success does not duplicate the payment row', () => {
  it('skips the audit write when this charge reference is already recorded for the workspace', async () => {
    h.db = seed({ audit_log: [{ workspace_id: 'wA', event_type: 'billing.payment_succeeded', metadata: { reference: 'r1' } }] })
    expect(await send(charge('r1'))).toBe(200)
    expect(paymentRows()).toHaveLength(0)
  })
  it('a different charge reference is still recorded', async () => {
    h.db = seed({ audit_log: [{ workspace_id: 'wA', event_type: 'billing.payment_succeeded', metadata: { reference: 'r1' } }] })
    expect(await send(charge('r2'))).toBe(200)
    expect(paymentRows()).toHaveLength(1)
    expect(paymentRows()[0].metadata.reference).toBe('r2')
  })
  it('the same reference on ANOTHER workspace does not suppress the row', async () => {
    h.db = seed({ audit_log: [{ workspace_id: 'wOther', event_type: 'billing.payment_succeeded', metadata: { reference: 'r1' } }] })
    expect(await send(charge('r1'))).toBe(200)
    expect(paymentRows()).toHaveLength(1)
  })
  it('a failing duplicate lookup writes the row anyway (a duplicate line beats a missing one)', async () => {
    h.db = seed({}, { errors: [{ table: 'audit_log', op: 'select' }] })
    expect(await send(charge('r3'))).toBe(200)
    expect(paymentRows()).toHaveLength(1)
  })
})
