// tests/billing-cancel-claim.test.ts
//
// Billing independent pass — B1 / B7 / B8 (api/billing/cancel).
//
// The cancel route used to call Paystack FIRST and write billing.cancels_at_period_end AFTER, by workspace_id
// alone. A plan switch landing during the (up to 24s) Paystack call therefore had its brand-new subscription
// flagged as cancelling, and the not_renew webhook / a second click could each add a duplicate audit row + email.
// It now CLAIMS first (compare-and-set on the subscription code and on the flag = false), then calls Paystack,
// and rolls the claim back if Paystack refuses. These tests pin that ordering by mutating the fake DB from
// inside the mocked Paystack call / the claim write, exactly where the real race lives.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, cancelImpl: null as any,
  cancelCalls: 0, audits: [] as any[], emails: [] as any[], alerts: [] as any[],
  // Billing pass 10 (B2): billing/cancel re-reads the subscription before rolling back a failed disable.
  statusImpl: (() => ({ ok: false, notFound: false, error: 'unreachable' })) as any,
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'owner@agency.test', name: 'Owner', workspaceId: 'w1', agencyName: 'Agency' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '127.0.0.1' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async (_s: any, _w: string, extra: any[]) => extra }))
vi.mock('@/lib/billing/ops-alert', () => ({
  alertBillingOps: async (_s: any, key: string, subject: string, lines: string[]) => { h.alerts.push({ key, subject, lines }); return true },
}))
vi.mock('@/lib/email/templates', () => ({ sendSubscriptionCancelScheduledEmail: async (p: any) => { h.emails.push(p) } }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async (b: any) => { h.cancelCalls++; return h.cancelImpl(b) },
  fetchPaystackSubscription: async () => h.statusImpl(),
}))

import { POST } from '@/app/api/billing/cancel/route'

const billingRow = (over: Row = {}): Row => ({
  workspace_id: 'w1', paystack_subscription_code: 'SUB_OLD', paystack_email_token: 'tok',
  cancels_at_period_end: false, current_period_end: '2099-01-01T00:00:00.000Z', ...over,
})
const rowOf = () => h.db.tables.billing.find((r: any) => r.workspace_id === 'w1')
const call = async () => { const res: any = await POST({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  h.cancelCalls = 0; h.audits.length = 0; h.emails.length = 0; h.alerts.length = 0
  h.cancelImpl = async () => ({ ok: true, alreadyCancelled: false })
  h.statusImpl = () => ({ ok: false, notFound: false, error: 'unreachable' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('billing/cancel — claim first, then Paystack', () => {
  it('cancels: flag set, one audit row, one email', async () => {
    h.db = createFakeSupabase({ billing: [billingRow()] })
    const r = await call()
    expect(r.status).toBe(200)
    expect(rowOf().cancels_at_period_end).toBe(true)
    expect(h.cancelCalls).toBe(1)
    expect(h.audits.length).toBe(1)
    expect(h.emails.length).toBe(1)
  })

  it('B1: a plan switch that lands DURING the Paystack call is not flagged as cancelling, and the customer is told', async () => {
    h.db = createFakeSupabase({ billing: [billingRow()] })
    h.cancelImpl = async () => {
      Object.assign(rowOf(), { paystack_subscription_code: 'SUB_NEW', cancels_at_period_end: false })
      return { ok: true, alreadyCancelled: false }
    }
    const r = await call()
    expect(r.status).toBe(409)
    expect(r.body.planChanged).toBe(true)
    expect(rowOf().paystack_subscription_code).toBe('SUB_NEW')
    expect(rowOf().cancels_at_period_end).toBe(false)   // the new, paid subscription must keep renewing
    expect(h.audits.length).toBe(0)                     // and nothing claims a cancellation happened
    expect(h.emails.length).toBe(0)
  })

  it('B1: a plan switch that lands BETWEEN the read and the claim cancels nothing and never calls Paystack', async () => {
    let fired = false
    h.db = createFakeSupabase({ billing: [billingRow()] }, {
      errors: [{
        table: 'billing', op: 'update',
        when: () => { if (!fired) { fired = true; rowOf().paystack_subscription_code = 'SUB_NEW' } return false }, // side effect only
      }],
    })
    const r = await call()
    expect(r.status).toBe(409)
    expect(h.cancelCalls).toBe(0)
    expect(rowOf().cancels_at_period_end).toBe(false)
  })

  it('a Paystack refusal rolls the claim back, so a subscription that still renews is not marked as ending', async () => {
    h.db = createFakeSupabase({ billing: [billingRow()] })
    h.cancelImpl = async () => ({ ok: false, error: 'boom' })
    const r = await call()
    expect(r.status).toBe(502)
    expect(rowOf().cancels_at_period_end).toBe(false)
    expect(h.audits.length).toBe(0)
    expect(h.emails.length).toBe(0)
  })

  it('pages ops when the rollback itself cannot be written (renewing on Paystack, "ending" locally)', async () => {
    h.db = createFakeSupabase({ billing: [billingRow()] }, {
      errors: [{ table: 'billing', op: 'update', when: (p: any) => p.cancels_at_period_end === false }],
    })
    h.cancelImpl = async () => ({ ok: false, error: 'boom' })
    const r = await call()
    expect(r.status).toBe(502)
    expect(h.alerts.some(a => a.key.startsWith('billing:cancel-rollback'))).toBe(true)
  })

  it('B7: two concurrent clicks -> one cancellation, one Paystack call, one audit row, one email', async () => {
    h.db = createFakeSupabase({ billing: [billingRow()] })
    const [a, b] = await Promise.all([call(), call()])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(h.cancelCalls).toBe(1)
    expect(h.audits.length).toBe(1)
    expect(h.emails.length).toBe(1)
  })

  it('B7: if the not_renew webhook already recorded the cancellation, this is a 409 with no second Paystack call', async () => {
    h.db = createFakeSupabase({ billing: [billingRow({ cancels_at_period_end: true })] })
    const r = await call()
    expect(r.status).toBe(409)
    expect(h.cancelCalls).toBe(0)
  })

  it('a failed billing read is a 500, not "no subscription — contact support"', async () => {
    h.db = createFakeSupabase({ billing: [billingRow()] }, { errors: [{ table: 'billing', op: 'select' }] })
    const r = await call()
    expect(r.status).toBe(500)
    expect(r.body.contactSupport).toBeUndefined()
  })

  it('no subscription on file still gets the contact-support answer', async () => {
    h.db = createFakeSupabase({ billing: [billingRow({ paystack_subscription_code: null })] })
    const r = await call()
    expect(r.status).toBe(422)
    expect(r.body.contactSupport).toBe(true)
  })
})
