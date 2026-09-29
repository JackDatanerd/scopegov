// tests/billing-resume-guard.test.ts
//
// Billing independent pass — api/billing/resume: the local write is pinned to the subscription code that was
// re-enabled (a plan switch landing mid-call must not be reported as "resumed"), a failed read is not
// "no subscription", and a lost local write pages ops.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, resumeImpl: null as any, audits: [] as any[], emails: [] as any[], alerts: [] as any[] }))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'owner@agency.test', name: 'Owner', workspaceId: 'w1', agencyName: 'Agency' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '127.0.0.1' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async (_s: any, _w: string, extra: any[]) => extra }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async (_s: any, key: string, subject: string) => { h.alerts.push({ key, subject }); return true } }))
vi.mock('@/lib/email/templates', () => ({ sendSubscriptionResumedEmail: async (p: any) => { h.emails.push(p) } }))
vi.mock('@/lib/integrations/paystack', () => ({ resumePaystackSubscription: async (b: any) => h.resumeImpl(b) }))

import { POST } from '@/app/api/billing/resume/route'

const ending = (over: Row = {}): Row => ({
  workspace_id: 'w1', paystack_subscription_code: 'SUB_OLD', paystack_email_token: 'tok',
  cancels_at_period_end: true, current_period_end: '2099-01-01T00:00:00.000Z', ...over,
})
const rowOf = () => h.db.tables.billing.find((r: any) => r.workspace_id === 'w1')
const call = async () => { const r: any = await POST({} as any); return { status: r.status as number, body: await r.json() } }

beforeEach(() => {
  h.audits.length = 0; h.emails.length = 0; h.alerts.length = 0
  h.resumeImpl = async () => ({ ok: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('billing/resume', () => {
  it('resumes: flag cleared, audited, emailed', async () => {
    h.db = createFakeSupabase({ billing: [ending()] })
    const r = await call()
    expect(r.status).toBe(200)
    expect(rowOf().cancels_at_period_end).toBe(false)
    expect(h.audits.length).toBe(1)
    expect(h.emails.length).toBe(1)
  })

  it('a plan switch that replaces the subscription during the Paystack call is reported, not announced as "resumed"', async () => {
    h.db = createFakeSupabase({ billing: [ending()] })
    h.resumeImpl = async () => { Object.assign(rowOf(), { paystack_subscription_code: 'SUB_NEW', cancels_at_period_end: false }); return { ok: true } }
    const r = await call()
    expect(r.status).toBe(409)
    expect(r.body.planChanged).toBe(true)
    expect(rowOf().paystack_subscription_code).toBe('SUB_NEW')
    expect(h.audits.length).toBe(0)
    expect(h.emails.length).toBe(0)
  })

  it('pages ops when Paystack re-enabled renewal but the local flag could not be cleared', async () => {
    h.db = createFakeSupabase({ billing: [ending()] }, { errors: [{ table: 'billing', op: 'update' }] })
    await call()
    expect(h.alerts.some(a => a.key.startsWith('billing:resume-local-write'))).toBe(true)
  })

  it('a failed billing read is a 500, not "no subscription"', async () => {
    h.db = createFakeSupabase({ billing: [ending()] }, { errors: [{ table: 'billing', op: 'select' }] })
    expect((await call()).status).toBe(500)
  })
})
