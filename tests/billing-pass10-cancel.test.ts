// tests/billing-pass10-cancel.test.ts
//
// Billing independent pass 10 — api/billing/cancel:
//   B1  no usable date from Paystack -> estimate from recorded state (never flag against an elapsed/missing date
//       when a safe estimate exists); ops is told when a NULL date is unavoidable
//   B2  a disable that failed ambiguously (timeout / lost response) but actually took effect is success, not a rollback
//   B4  a rejected notification email is logged and, when nobody was reached, paged

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, audits: [] as any[], emails: [] as any[], alerts: [] as any[], next: null as any,
  cancelImpl: null as any, statusImpl: null as any, emailImpl: null as any,
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
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async (_s: any, key: string, subject: string) => { h.alerts.push({ key, subject }); return true } }))
vi.mock('@/lib/email/templates', () => ({ sendSubscriptionCancelScheduledEmail: async (p: any) => { h.emails.push(p); return h.emailImpl() } }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => h.cancelImpl(),
  fetchPaystackNextPaymentDate: async () => h.next,
  fetchPaystackSubscription: async () => h.statusImpl(),
}))

import { POST } from '@/app/api/billing/cancel/route'
import { addBillingInterval } from '@/lib/billing/period-end'

const DAY = 86_400_000
const row = (over: Row = {}): Row => ({
  workspace_id: 'w1', paystack_subscription_code: 'SUB_A', paystack_email_token: 'tok', cancels_at_period_end: false,
  grace_period_started_at: null, plan_interval: 'monthly', current_period_end: new Date(Date.now() + 20 * DAY).toISOString(), ...over,
})
const rowOf = () => h.db.tables.billing.find((r: any) => r.workspace_id === 'w1')
const call = async () => { const res: any = await POST({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  h.audits.length = 0; h.emails.length = 0; h.alerts.length = 0; h.next = null
  h.cancelImpl = async () => ({ ok: true, alreadyCancelled: false })
  h.statusImpl = () => ({ ok: false, notFound: false, error: 'unreachable' })
  h.emailImpl = () => ({ ok: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('B1 — no usable date from Paystack', () => {
  it('a just-renewed subscription (stored date elapsed, Paystack still shows it) is given one interval more, not a past date', async () => {
    const stored = Date.now() - 2 * 3_600_000
    h.db = createFakeSupabase({ billing: [row({ current_period_end: new Date(stored).toISOString() })] })
    h.next = new Date(stored).toISOString() // Paystack has not refreshed either
    const r = await call()
    const expected = new Date(addBillingInterval(stored, 'monthly')).toISOString()
    expect(r.status).toBe(200)
    expect(rowOf().cancels_at_period_end).toBe(true)
    expect(rowOf().current_period_end).toBe(expected)
    expect(r.body.endsAt).toBe(expected)
    expect(h.audits[0].metadata.period_end_estimated).toBe(true)
    expect(h.emails[0].endsAtLabel).not.toBe('the end of your current billing period')
  })

  it('a missing date is anchored on the newest recorded payment', async () => {
    const paid = Date.now() - 12 * DAY
    h.db = createFakeSupabase({
      billing: [row({ current_period_end: null })],
      audit_log: [{ workspace_id: 'w1', event_type: 'billing.payment_succeeded', created_at: new Date(paid).toISOString(), metadata: { paid_at: new Date(paid).toISOString() } }],
    })
    const r = await call()
    expect(r.status).toBe(200)
    expect(rowOf().current_period_end).toBe(new Date(addBillingInterval(paid, 'monthly')).toISOString())
    expect(h.alerts).toHaveLength(0)
  })

  it('does not guess while a payment is failing: an elapsed date is left alone (ending promptly is correct)', async () => {
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString()
    h.db = createFakeSupabase({ billing: [row({ current_period_end: old, grace_period_started_at: new Date().toISOString() })] })
    const r = await call()
    expect(r.status).toBe(200)
    expect(rowOf().current_period_end).toBe(old)
    expect(h.audits[0].metadata.period_end_estimated).toBeUndefined()
  })

  it('with no date and no estimate the cancellation still goes through, and ops is paged', async () => {
    h.db = createFakeSupabase({ billing: [row({ current_period_end: null })] })
    const r = await call()
    expect(r.status).toBe(200)
    expect(rowOf().cancels_at_period_end).toBe(true)
    expect(rowOf().current_period_end).toBeNull()
    expect(h.alerts.some(a => a.key.startsWith('billing:cancel-no-period-end'))).toBe(true)
  })

  it('a healthy future date is untouched and needs no estimate or page', async () => {
    const keep = new Date(Date.now() + 9 * DAY).toISOString()
    h.db = createFakeSupabase({ billing: [row({ current_period_end: keep })] })
    const r = await call()
    expect(r.status).toBe(200)
    expect(rowOf().current_period_end).toBe(keep)
    expect(h.alerts).toHaveLength(0)
  })
})

describe('B2 — a failed disable that Paystack actually applied', () => {
  it('status read says non-renewing -> success: the claim stays, history + email are written, no 502', async () => {
    h.db = createFakeSupabase({ billing: [row()] })
    h.cancelImpl = async () => ({ ok: false, alreadyCancelled: false, error: 'timeout' })
    h.statusImpl = () => ({ ok: true, sub: { status: 'non-renewing' } })
    const r = await call()
    expect(r.status).toBe(200)
    expect(rowOf().cancels_at_period_end).toBe(true)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0].metadata.was_already_non_renewing_upstream).toBe(true)
  })
  it('status read says still active -> rolled back exactly as before', async () => {
    h.db = createFakeSupabase({ billing: [row()] })
    h.cancelImpl = async () => ({ ok: false, alreadyCancelled: false, error: 'boom' })
    h.statusImpl = () => ({ ok: true, sub: { status: 'active' } })
    const r = await call()
    expect(r.status).toBe(502)
    expect(rowOf().cancels_at_period_end).toBe(false)
    expect(h.audits).toHaveLength(0)
  })
  it('status read itself failing -> rolled back (never claims success without evidence)', async () => {
    h.db = createFakeSupabase({ billing: [row()] })
    h.cancelImpl = async () => ({ ok: false, alreadyCancelled: false, error: 'boom' })
    const r = await call()
    expect(r.status).toBe(502)
    expect(rowOf().cancels_at_period_end).toBe(false)
  })
})

describe('B4 — notification email results are not discarded', () => {
  it('a rejected send is logged, and when nobody was reached ops is paged', async () => {
    h.db = createFakeSupabase({ billing: [row()] })
    h.emailImpl = () => ({ ok: false, error: 'rejected recipient' })
    const r = await call()
    expect(r.status).toBe(200)
    expect(h.alerts.some(a => a.key.startsWith('billing:cancel-email'))).toBe(true)
  })
  it('a delivered send pages nobody', async () => {
    h.db = createFakeSupabase({ billing: [row()] })
    await call()
    expect(h.alerts).toHaveLength(0)
  })
})
