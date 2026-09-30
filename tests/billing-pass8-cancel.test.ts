// tests/billing-pass8-cancel.test.ts
//
// Billing independent pass 8 — B1 (api/billing/cancel).
// A stored current_period_end that is PRESENT but already elapsed (a renewal the webhook has not refreshed
// yet) must be refreshed from Paystack before the cancellation is claimed. Otherwise payment-overdue step 5
// (cancelling rows whose period end has passed) downgrades a customer who has just paid another period.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, nextDate: null as any, fetchCalls: 0, fetchThrows: false, emails: [] as any[], audits: [] as any[],
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
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/email/templates', () => ({ sendSubscriptionCancelScheduledEmail: async (p: any) => { h.emails.push(p); return { ok: true } } }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => ({ ok: true, alreadyCancelled: false }),
  fetchPaystackNextPaymentDate: async () => { h.fetchCalls++; if (h.fetchThrows) throw new Error('paystack down'); return h.nextDate },
}))

import { POST } from '@/app/api/billing/cancel/route'

const DAY = 86_400_000
const billingRow = (over: Row = {}): Row => ({
  workspace_id: 'w1', paystack_subscription_code: 'SUB_OLD', paystack_email_token: 'tok',
  cancels_at_period_end: false, current_period_end: new Date(Date.now() + 20 * DAY).toISOString(), ...over,
})
const rowOf = () => h.db.tables.billing.find((r: any) => r.workspace_id === 'w1')
const call = async () => { const res: any = await POST({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  h.fetchCalls = 0; h.fetchThrows = false; h.nextDate = null; h.emails.length = 0; h.audits.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('billing/cancel — elapsed current_period_end is refreshed before the claim (pass 8 B1)', () => {
  it('an elapsed stored date is replaced by Paystack\'s next payment date, and that date is what the customer is told', async () => {
    const fresh = new Date(Date.now() + 30 * DAY).toISOString()
    h.nextDate = fresh
    h.db = createFakeSupabase({ billing: [billingRow({ current_period_end: new Date(Date.now() - 2 * 3_600_000).toISOString() })] })
    const r = await call()
    expect(r.status).toBe(200)
    expect(h.fetchCalls).toBe(1)
    expect(rowOf().cancels_at_period_end).toBe(true)
    expect(rowOf().current_period_end).toBe(fresh)
    expect(r.body.endsAt).toBe(fresh)
    expect(h.audits[0].metadata.ends_at).toBe(fresh)
  })

  it('a future stored date is trusted: no extra Paystack round trip', async () => {
    h.db = createFakeSupabase({ billing: [billingRow()] })
    const r = await call()
    expect(r.status).toBe(200)
    expect(h.fetchCalls).toBe(0)
  })

  it('a missing date is still backfilled (pass 7 behaviour preserved)', async () => {
    const fresh = new Date(Date.now() + 10 * DAY).toISOString()
    h.nextDate = fresh
    h.db = createFakeSupabase({ billing: [billingRow({ current_period_end: null })] })
    const r = await call()
    expect(r.status).toBe(200)
    expect(rowOf().current_period_end).toBe(fresh)
  })

  it('if Paystack still reports an elapsed/empty date, or cannot be reached, the cancel still goes through unchanged', async () => {
    const stale = new Date(Date.now() - 3_600_000).toISOString()
    h.nextDate = null
    h.db = createFakeSupabase({ billing: [billingRow({ current_period_end: stale })] })
    expect((await call()).status).toBe(200)
    expect(rowOf().current_period_end).toBe(stale)

    h.fetchThrows = true
    h.db = createFakeSupabase({ billing: [billingRow({ current_period_end: stale })] })
    expect((await call()).status).toBe(200)
    expect(rowOf().cancels_at_period_end).toBe(true)
  })
})
