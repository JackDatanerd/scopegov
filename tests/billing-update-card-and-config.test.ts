// tests/billing-update-card-and-config.test.ts
//
// Billing independent pass:
//   G1 — api/billing/update-card (change the card on the EXISTING subscription);
//   B5 — api/billing/upgrade refuses to record a checkout when payments are not configured.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, link: null as any, audits: [] as any[], linkCalls: [] as any[] }))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'owner@agency.test', name: 'Owner', workspaceId: 'w1', agencyName: 'Agency', userId: 'u1' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '127.0.0.1' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/integrations/paystack', () => ({
  generatePaystackManageLink: async (code: string) => { h.linkCalls.push(code); return h.link(code) },
}))

import { POST as updateCard } from '@/app/api/billing/update-card/route'
import { POST as upgrade } from '@/app/api/billing/upgrade/route'

const billing = (over: Row = {}): Row => ({ workspace_id: 'w1', paystack_subscription_code: 'SUB_A', cancels_at_period_end: false, ...over })
const callCard = async () => { const r: any = await updateCard({} as any); return { status: r.status as number, body: await r.json() } }

beforeEach(() => {
  h.audits.length = 0; h.linkCalls.length = 0
  h.link = async () => ({ ok: true, link: 'https://paystack.com/manage/abc' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('billing/update-card', () => {
  it('returns the Paystack-hosted link for the CURRENT subscription and audits the start', async () => {
    h.db = createFakeSupabase({ billing: [billing()] })
    const r = await callCard()
    expect(r.status).toBe(200)
    expect(r.body.url).toBe('https://paystack.com/manage/abc')
    expect(h.linkCalls).toEqual(['SUB_A'])
    expect(h.audits[0].eventType).toBe('billing.card_update_started')
  })

  it('has nothing to update without a subscription (422), and points at the plans', async () => {
    h.db = createFakeSupabase({ billing: [billing({ paystack_subscription_code: null })] })
    const r = await callCard()
    expect(r.status).toBe(422)
    expect(h.linkCalls.length).toBe(0)
  })

  it('refuses on a subscription that is set to end (resume it first)', async () => {
    h.db = createFakeSupabase({ billing: [billing({ cancels_at_period_end: true })] })
    expect((await callCard()).status).toBe(409)
    expect(h.linkCalls.length).toBe(0)
  })

  it('a Paystack failure is a 502 with nothing recorded', async () => {
    h.db = createFakeSupabase({ billing: [billing()] })
    h.link = async () => ({ ok: false, error: 'down' })
    const r = await callCard()
    expect(r.status).toBe(502)
    expect(h.audits.length).toBe(0)
  })

  it('a failed billing read is a 500, not "no subscription"', async () => {
    h.db = createFakeSupabase({ billing: [billing()] }, { errors: [{ table: 'billing', op: 'select' }] })
    expect((await callCard()).status).toBe(500)
  })
})

describe('billing/upgrade — payments must be configured (B5)', () => {
  const call = async () => { const r: any = await upgrade({ json: async () => ({ planKey: 'solo', interval: 'monthly' }) } as any); return { status: r.status as number, body: await r.json() } }
  beforeEach(() => {
    process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'
    process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY = 'pk_test_x'
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_x'
    h.db = createFakeSupabase({ workspaces: [{ id: 'w1', plan_tier: 'trial' }], billing: [], billing_checkouts: [] })
  })

  it('a missing SECRET key (every webhook would 401) refuses before recording a checkout', async () => {
    delete process.env.PAYSTACK_SECRET_KEY
    const r = await call()
    expect(r.status).toBe(503)
    expect((h.db.tables.billing_checkouts || []).length).toBe(0)
  })

  it('a missing PUBLIC key (popup would get publicKey: undefined) refuses before recording a checkout', async () => {
    delete process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY
    const r = await call()
    expect(r.status).toBe(503)
    expect((h.db.tables.billing_checkouts || []).length).toBe(0)
  })
})
