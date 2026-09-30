// tests/billing-pass8-webhook.test.ts
//
// Billing independent pass 8 — B2 (webhook invoice.payment_failed).
// The grace window is written first, so on redelivery newlyStarted is false and the first-failure email can
// never be re-sent. It therefore must not be lost to (a) a transient failure of the cosmetic agency-name
// read, or (b) a rejected send ({ ok: false } is returned, not thrown).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, audits: [] as any[], emails: [] as any[], alerts: [] as any[], sendResult: { ok: true } as any,
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/email/templates', () => ({
  sendPaymentFailedEmail: async (p: any) => { h.emails.push(p); return h.sendResult },
  sendCardExpiringEmail: async () => ({ ok: true }),
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

process.env.PAYSTACK_SECRET_KEY = 'sk_test_pass8'
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

const EMAIL = 'owner@agency.test'
const failed = (code: string, ref: string) => ({ event: 'invoice.payment_failed', data: {
  amount: 2500, currency: 'USD', reference: ref, customer: { email: EMAIL, customer_code: 'CUS_1' }, subscription: { subscription_code: code },
} })
const send = async (ev: any) => {
  const raw = JSON.stringify(ev)
  const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex')
  const res: any = await POST({ text: async () => raw, headers: { get: (n: string) => (n.toLowerCase() === 'x-paystack-signature' ? sig : null) } } as any)
  return { status: res.status as number, body: await res.json() }
}
const liveBilling = (): Row => ({ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_A', cancels_at_period_end: false, grace_period_started_at: null })
const seed = (opts: any = {}) => createFakeSupabase({
  workspaces: [{ id: 'wA', plan_tier: 'solo', deleted_at: null, agency_name: 'Acme' }], billing: [liveBilling()],
}, opts)

beforeEach(() => {
  h.audits.length = 0; h.emails.length = 0; h.alerts.length = 0; h.sendResult = { ok: true }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('invoice.payment_failed — the first-failure email is not lost (pass 8 B2)', () => {
  it('a failing agency-name read does not fail the event or drop the email (fallback name used)', async () => {
    h.db = seed({ errors: [{ table: 'workspaces', op: 'select' }] })
    const r = await send(failed('SUB_A', 'r1'))
    expect(r.status).toBe(200)
    expect(h.db.tables.billing[0].grace_period_started_at).toBeTruthy()
    expect(h.emails.length).toBe(1)
    expect(h.emails[0].agencyName).toBe('your workspace')
    expect(h.audits[0].eventType).toBe('billing.payment_failed_grace_started')
  })

  it('a rejected send ({ ok: false }) pages ops instead of vanishing', async () => {
    h.sendResult = { ok: false, error: 'provider rejected' }
    h.db = seed()
    const r = await send(failed('SUB_A', 'r1'))
    expect(r.status).toBe(200)
    expect(h.alerts.some(a => a.key === 'billing:payment-failed-email:wA')).toBe(true)
    expect(h.audits[0].eventType).toBe('billing.payment_failed_grace_started')
  })

  it('a delivered email does not page ops, and a Paystack retry still sends nothing more', async () => {
    h.db = seed()
    await send(failed('SUB_A', 'r1'))
    await send(failed('SUB_A', 'r2'))
    expect(h.emails.length).toBe(1)
    expect(h.alerts.length).toBe(0)
  })
})
