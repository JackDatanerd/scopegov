// tests/billing-pass12.test.ts
//
// Billing independent pass 12:
//   B1  the "subscription ended" email no longer tells a customer whose card failed that they "requested" it
//   B2  a re-run of invoice.payment_failed / charge.dispute.* does not append a second history row, and the
//       failed-payment row records the charge reference from the embedded transaction
//   B3  a subscription.disable for the OLD subscription of a plan switch does not page ops when the customer is
//       shared by several workspaces
//   B4  subscription.create without next_payment_date does not keep the previous plan's period end

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, audits: [] as any[], alerts: [] as any[], sent: [] as any[] }))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/email/send', () => ({ sendEmail: async (p: any) => { h.sent.push(p); return { ok: true, id: 'x' } } }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [] }))
vi.mock('@/lib/billing/ops-alert', () => ({
  alertBillingOps: async (_s: any, key: string, subject: string, lines: string[]) => { h.alerts.push({ key, subject, lines }); return true },
}))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => ({ ok: true }),
  fetchPaystackNextPaymentDate: async () => null,
}))

import { POST } from '@/app/api/billing/webhook/route'
import { sendSubscriptionEndedEmail } from '@/lib/email/templates'
import { createHmac } from 'crypto'

process.env.PAYSTACK_SECRET_KEY = 'sk_pass12'
process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'
process.env.PAYSTACK_PLAN_PRO_MONTHLY = 'PLN_pm'
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

const EMAIL = 'owner@agency.test'
const send = async (e: any) => {
  const raw = JSON.stringify(e)
  const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex')
  const res: any = await POST({ text: async () => raw, headers: { get: (n: string) => (n.toLowerCase() === 'x-paystack-signature' ? sig : null) } } as any)
  return res.status as number
}

beforeEach(() => {
  h.audits.length = 0; h.alerts.length = 0; h.sent.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('B1 — subscription-ended email wording', () => {
  const base = { to: 'a@agency.test', name: 'Ann', agencyName: 'Acme', upgradeUrl: 'https://app.test/settings?tab=billing' }
  it('a cancellation keeps the "As requested" wording', async () => {
    await sendSubscriptionEndedEmail(base)
    expect(h.sent.at(-1).html).toContain('As requested')
  })
  it('a non-payment downgrade never claims the customer asked for it', async () => {
    await sendSubscriptionEndedEmail({ ...base, reason: 'nonpayment' })
    const html: string = h.sent.at(-1).html
    expect(html).not.toContain('As requested')
    expect(html).toContain('not able to collect payment')
    expect(html).toContain('Solo plan')
  })
})

describe('B2 — payment_failed / dispute re-runs', () => {
  const seedFailed = (audit: Row[]) => createFakeSupabase({
    workspaces: [{ id: 'wA', plan_tier: 'pro', deleted_at: null, agency_name: 'Acme' }],
    billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_A', cancels_at_period_end: false, grace_period_started_at: new Date().toISOString(), plan_interval: 'monthly', current_period_end: null }],
    audit_log: audit,
  })
  const failed = (extra: Record<string, unknown>) => ({ event: 'invoice.payment_failed', data: {
    amount: 2500, currency: 'USD', customer: { email: EMAIL, customer_code: 'CUS_1' }, subscription: { subscription_code: 'SUB_A' }, ...extra,
  } })

  it('records the reference from the embedded transaction', async () => {
    h.db = seedFailed([])
    expect(await send(failed({ transaction: { reference: 'T1' } }))).toBe(200)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0].metadata.reference).toBe('T1')
  })
  it('skips the row when this failure was already recorded as the first-failure row', async () => {
    h.db = seedFailed([{ workspace_id: 'wA', event_type: 'billing.payment_failed_grace_started', metadata: { reference: 'T1' } }])
    expect(await send(failed({ transaction: { reference: 'T1' } }))).toBe(200)
    expect(h.audits).toHaveLength(0)
  })
  it('a failure with a different reference is still recorded', async () => {
    h.db = seedFailed([{ workspace_id: 'wA', event_type: 'billing.payment_retry_failed', metadata: { reference: 'T1' } }])
    expect(await send(failed({ transaction: { reference: 'T2' } }))).toBe(200)
    expect(h.audits).toHaveLength(1)
  })
  it('a re-run dispute is not duplicated, but a second partial refund on one transaction is kept', async () => {
    h.db = seedFailed([
      { workspace_id: 'wA', event_type: 'billing.charge_dispute_create', metadata: { reference: 'T1' } },
      { workspace_id: 'wA', event_type: 'billing.refund_processed', metadata: { reference: 'T1' } },
    ])
    const ctx = { customer: { email: EMAIL, customer_code: 'CUS_1' }, subscription: { subscription_code: 'SUB_A' } }
    expect(await send({ event: 'charge.dispute.create', data: { ...ctx, transaction_reference: 'T1', status: 'awaiting-merchant-feedback' } })).toBe(200)
    expect(h.audits).toHaveLength(0)
    expect(await send({ event: 'refund.processed', data: { ...ctx, transaction_reference: 'T1', amount: 500, status: 'processed' } })).toBe(200)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0].eventType).toBe('billing.refund_processed')
  })
})

describe('B3 — old-subscription disable event with a customer shared by several workspaces', () => {
  const seed = () => createFakeSupabase({
    workspaces: [{ id: 'wA', plan_tier: 'solo', deleted_at: null }, { id: 'wB', plan_tier: 'solo', deleted_at: null }],
    billing: [
      { workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_A', cancels_at_period_end: false, plan_interval: 'monthly', current_period_end: null },
      { workspace_id: 'wB', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_B', cancels_at_period_end: false, plan_interval: 'monthly', current_period_end: null },
    ],
  })
  const disable = (code?: string) => ({ event: 'subscription.disable', data: {
    ...(code ? { subscription_code: code } : {}), customer: { email: EMAIL, customer_code: 'CUS_1' }, plan: { plan_code: 'PLN_sm' },
  } })

  it('ignores a disable for a subscription no workspace holds, without paging ops or touching either row', async () => {
    h.db = seed()
    expect(await send(disable('SUB_OLD'))).toBe(200)
    expect(h.alerts).toHaveLength(0)
    expect(h.db.tables.billing.every((r: Row) => r.cancels_at_period_end === false)).toBe(true)
  })
  it('still pages ops when the event names no subscription at all (genuinely undecidable)', async () => {
    h.db = seed()
    expect(await send(disable())).toBe(200)
    expect(h.alerts).toHaveLength(1)
  })
})

describe('B4 — subscription.create without next_payment_date', () => {
  it('does not keep the previous plan\'s period end on the new row', async () => {
    const oldEnd = new Date(Date.now() + 10 * 86_400_000).toISOString()
    h.db = createFakeSupabase({
      workspaces: [{ id: 'wA', plan_tier: 'solo', deleted_at: null, agency_name: 'A' }],
      billing: [{ workspace_id: 'wA', paystack_customer_code: 'CUS_1', paystack_subscription_code: 'SUB_OLD', paystack_email_token: 'tk', cancels_at_period_end: false, plan_interval: 'monthly', current_period_end: oldEnd }],
      billing_checkouts: [{ id: 'c1', workspace_id: 'wA', user_id: 'u', email: EMAIL, plan_key: 'pro', plan_interval: 'monthly', plan_code: 'PLN_pm', created_at: new Date().toISOString(), consumed_at: null }],
    })
    const ev = { event: 'subscription.create', data: {
      subscription_code: 'SUB_NEW', email_token: 'tok2', customer: { email: EMAIL, customer_code: 'CUS_1' }, plan: { plan_code: 'PLN_pm' },
    } }
    expect(await send(ev)).toBe(200)
    const row = h.db.tables.billing.find((r: Row) => r.workspace_id === 'wA')
    expect(row.paystack_subscription_code).toBe('SUB_NEW')
    expect(row.current_period_end).toBeNull()
  })
})
