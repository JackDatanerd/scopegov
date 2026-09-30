// Billing independent pass 7 — B1 (cancel/resume audit loss) + latent (cancel with no current_period_end).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, auditOk: true, auditCalls: 0, audits: [] as any[], alerts: [] as any[], fetched: null as string | null }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'owner@agency.test', name: 'Owner', workspaceId: 'w1', agencyName: 'Agency' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '127.0.0.1' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.auditCalls++; if (!h.auditOk) return false; h.audits.push(p); return true } }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async (_s: any, _w: string, extra: any[]) => extra }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async (_s: any, key: string, subject: string) => { h.alerts.push({ key, subject }); return true } }))
vi.mock('@/lib/email/templates', () => ({
  sendSubscriptionCancelScheduledEmail: async () => {}, sendSubscriptionResumedEmail: async () => {},
}))
vi.mock('@/lib/integrations/paystack', () => ({
  fetchPaystackSubscription: async () => ({ ok: false, notFound: false, error: 'unreachable' }),
  cancelPaystackSubscription: async () => ({ ok: true, alreadyCancelled: false }),
  resumePaystackSubscription: async () => ({ ok: true }),
  fetchPaystackNextPaymentDate: async () => h.fetched,
}))

import { POST as cancel } from '@/app/api/billing/cancel/route'
import { POST as resume } from '@/app/api/billing/resume/route'

const row = (over: Record<string, any> = {}) => ({
  workspace_id: 'w1', paystack_subscription_code: 'SUB', paystack_email_token: 'tok',
  cancels_at_period_end: false, current_period_end: '2099-01-01T00:00:00.000Z', ...over,
})
const bill = () => h.db.tables.billing[0]

beforeEach(() => {
  h.auditOk = true; h.auditCalls = 0; h.audits.length = 0; h.alerts.length = 0; h.fetched = null
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('B1 — cancel/resume must not lose their history row silently', () => {
  it('cancel: a failed audit write is retried, ops is paged, and the cancellation still succeeds', async () => {
    h.db = createFakeSupabase({ billing: [row()] }); h.auditOk = false
    const res: any = await cancel({} as any)
    expect(res.status).toBe(200)
    expect(bill().cancels_at_period_end).toBe(true)
    expect(h.auditCalls).toBe(2)
    expect(h.alerts.some(a => a.subject.includes('audit row'))).toBe(true)
  })
  it('cancel: a transient audit failure is absorbed by the retry — no page', async () => {
    h.db = createFakeSupabase({ billing: [row()] })
    let n = 0
    const mod: any = await import('@/lib/utils/audit')
    const orig = mod.logAudit
    mod.logAudit = async (s: any, p: any) => (n++ === 0 ? (h.auditCalls++, false) : orig(s, p))
    const res: any = await cancel({} as any)
    mod.logAudit = orig
    expect(res.status).toBe(200)
    expect(h.audits.length).toBe(1)
    expect(h.alerts.length).toBe(0)
  })
  it('resume: a failed audit write pages ops and the resume still succeeds', async () => {
    h.db = createFakeSupabase({ billing: [row({ cancels_at_period_end: true })] }); h.auditOk = false
    const res: any = await resume({} as any)
    expect(res.status).toBe(200)
    expect(bill().cancels_at_period_end).toBe(false)
    expect(h.alerts.some(a => a.subject.includes('audit row'))).toBe(true)
  })
  it('healthy path: exactly one audit row, no page', async () => {
    h.db = createFakeSupabase({ billing: [row()] })
    expect(((await cancel({} as any)) as any).status).toBe(200)
    expect(h.audits.length).toBe(1); expect(h.alerts.length).toBe(0)
  })
})

describe('latent — cancel of a subscription with no current_period_end', () => {
  it('backfills the period end from Paystack so the period-end sweep can downgrade it later', async () => {
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString()
    h.db = createFakeSupabase({ billing: [row({ current_period_end: null })] }); h.fetched = future
    const res: any = await cancel({} as any)
    expect(res.status).toBe(200)
    expect((await res.json()).endsAt).toBe(future)
    expect(bill().current_period_end).toBe(future)
    expect(bill().cancels_at_period_end).toBe(true)
  })
  it('still cancels (old behaviour) when Paystack cannot supply a date', async () => {
    h.db = createFakeSupabase({ billing: [row({ current_period_end: null })] })
    const res: any = await cancel({} as any)
    expect(res.status).toBe(200)
    expect(bill().current_period_end).toBeNull()
  })
})
