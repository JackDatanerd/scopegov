// tests/billing-trial-end-upgrade-audit.test.ts
//
// Billing / trial-end audit:
//   B1  the Paystack PUBLIC key is accepted under PAYSTACK_PUBLIC_KEY, NEXT_CONFIG_PAYSTACK_PUBLIC_KEY and the original
//       NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY (a Vercel-driven rename made every checkout fail with "Payments are not available")
//   B2  a READ-ONLY (lapsed) workspace over the target plan's seat / project allowance can subscribe after acknowledging
//       the overage — it cannot deactivate members or archive projects, so the hard refusal was a dead end — while a
//       workspace that is NOT lapsed keeps the hard refusal
//   B3  the lapsed banner, Billing tab and Team banner say what is true for a read-only workspace

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, lapsed: false }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'owner@agency.test', name: 'Owner', workspaceId: 'w1', agencyName: 'Agency', lapsed: h.lapsed }),
  hasPermission: () => true,
}))

import { POST as upgrade } from '@/app/api/billing/upgrade/route'
import { getPaystackPublicKey, PAYSTACK_PUBLIC_KEY_ENV_NAMES } from '@/lib/billing/paystack-public-key'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const KEYS = [...PAYSTACK_PUBLIC_KEY_ENV_NAMES]
const clearKeys = () => { for (const k of KEYS) delete process.env[k] }

describe('B1 — the Paystack public key can live under any of its three names', () => {
  it('prefers PAYSTACK_PUBLIC_KEY, then NEXT_CONFIG_…, then the original NEXT_PUBLIC_…', () => {
    const all = { PAYSTACK_PUBLIC_KEY: 'pk_a', NEXT_CONFIG_PAYSTACK_PUBLIC_KEY: 'pk_b', NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: 'pk_c' }
    expect(getPaystackPublicKey(all)).toBe('pk_a')
    expect(getPaystackPublicKey({ NEXT_CONFIG_PAYSTACK_PUBLIC_KEY: 'pk_b', NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: 'pk_c' })).toBe('pk_b')
    expect(getPaystackPublicKey({ NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: 'pk_c' })).toBe('pk_c')
  })
  it('treats blank and whitespace-only values as unset', () => {
    expect(getPaystackPublicKey({ PAYSTACK_PUBLIC_KEY: '  ', NEXT_CONFIG_PAYSTACK_PUBLIC_KEY: 'pk_b' })).toBe('pk_b')
    expect(getPaystackPublicKey({ PAYSTACK_PUBLIC_KEY: '' })).toBeNull()
    expect(getPaystackPublicKey({})).toBeNull()
  })

  describe('api/billing/upgrade', () => {
    const call = async () => { const r: any = await upgrade({ json: async () => ({ planKey: 'solo', interval: 'monthly' }) } as any); return { status: r.status as number, body: await r.json() } }
    beforeEach(() => {
      clearKeys()
      process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_x'
      h.lapsed = false
      h.db = createFakeSupabase({
        workspaces: [{ id: 'w1', plan_tier: 'trial' }], billing: [], billing_checkouts: [],
        users: [{ id: 'u1', email: 'owner@agency.test' }],
        workspace_members: [{ id: 'm1', workspace_id: 'w1', status: 'active' }], projects: [],
      })
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    it('a deployment that renamed the variable to NEXT_CONFIG_PAYSTACK_PUBLIC_KEY gets a working checkout', async () => {
      process.env.NEXT_CONFIG_PAYSTACK_PUBLIC_KEY = 'pk_renamed'
      const r = await call()
      expect(r.status).toBe(200)
      expect(r.body.publicKey).toBe('pk_renamed')
    })
    it('the original name still works', async () => {
      process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY = 'pk_orig'
      const r = await call()
      expect(r.status).toBe(200)
      expect(r.body.publicKey).toBe('pk_orig')
    })
    it('with no key under any name it still refuses before recording a checkout', async () => {
      const r = await call()
      expect(r.status).toBe(503)
      expect((h.db.tables.billing_checkouts || []).length).toBe(0)
    })
  })
})

describe('B2 — a read-only workspace over the target plan can still subscribe (after acknowledging)', () => {
  const members = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, workspace_id: 'w1', status: 'active' }))
  const projects = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, workspace_id: 'w1', deleted_at: null, status: 'Active' }))
  const setup = (over: { members?: number; projects?: number; plan?: string } = {}) => {
    h.db = createFakeSupabase({
      workspaces: [{ id: 'w1', plan_tier: over.plan ?? 'solo' }], billing: [], billing_checkouts: [],
      users: [{ id: 'u1', email: 'owner@agency.test' }],
      workspace_members: members(over.members ?? 1), projects: projects(over.projects ?? 0),
    })
  }
  const call = async (body: Record<string, unknown> = {}) => {
    const r: any = await upgrade({ json: async () => ({ planKey: 'solo', interval: 'monthly', ...body }) } as any)
    return { status: r.status as number, body: await r.json() }
  }
  beforeEach(() => {
    clearKeys()
    process.env.PAYSTACK_PUBLIC_KEY = 'pk_test'
    process.env.PAYSTACK_SECRET_KEY = 'sk_test'
    process.env.PAYSTACK_PLAN_SOLO_MONTHLY = 'PLN_sm'
    h.lapsed = false
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('lapsed + too many members: first call asks for acknowledgement and records nothing', async () => {
    h.lapsed = true; setup({ members: 4 })
    const r = await call()
    expect(r.status).toBe(409)
    expect(r.body.overLimitAckRequired).toBe(true)
    expect(r.body.seatLimitExceeded).toBeUndefined()
    expect(r.body.overLimit.seats).toEqual({ count: 4, limit: 1 })
    expect(r.body.error).toMatch(/4 active members \(Solo includes 1\)/)
    expect(r.body.error).toMatch(/nobody is removed/)
    expect(h.db.tables.billing_checkouts || []).toHaveLength(0)
  })
  it('lapsed + too many members + acknowledged: checkout starts', async () => {
    h.lapsed = true; setup({ members: 4 })
    const r = await call({ acknowledgeOverLimit: true })
    expect(r.status).toBe(200)
    expect(r.body.planCode).toBe('PLN_sm')
    expect(h.db.tables.billing_checkouts).toHaveLength(1)
  })
  it('lapsed + too many projects: same acknowledgement flow, and it names the projects', async () => {
    h.lapsed = true; setup({ projects: 5 })
    const first = await call()
    expect(first.status).toBe(409)
    expect(first.body.overLimitAckRequired).toBe(true)
    expect(first.body.overLimit.projects).toEqual({ count: 5, limit: 3 })
    expect(first.body.error).toMatch(/5 active projects \(Solo includes 3\)/)
    expect((await call({ acknowledgeOverLimit: true })).status).toBe(200)
  })
  it('lapsed + both over: one message names both', async () => {
    h.lapsed = true; setup({ members: 3, projects: 4 })
    const r = await call()
    expect(r.body.error).toMatch(/3 active members.*and 4 active projects/)
  })
  it('lapsed but within the limits: no acknowledgement needed', async () => {
    h.lapsed = true; setup({ members: 1, projects: 2 })
    expect((await call()).status).toBe(200)
  })
  it('acknowledgement must be literally true, not just truthy', async () => {
    h.lapsed = true; setup({ members: 4 })
    expect((await call({ acknowledgeOverLimit: 'yes' })).status).toBe(409)
    expect((await call({ acknowledgeOverLimit: 1 })).status).toBe(409)
  })
  it('a workspace that is NOT lapsed keeps the hard refusal — even if the client sends the acknowledgement', async () => {
    h.lapsed = false; setup({ members: 4, plan: 'pro' })
    for (const body of [{}, { acknowledgeOverLimit: true }]) {
      const r = await call(body)
      expect(r.status).toBe(409)
      expect(r.body.seatLimitExceeded).toBe(true)
      expect(r.body.overLimitAckRequired).toBeUndefined()
      expect(r.body.error).toMatch(/Deactivate members down to the new limit first/)
    }
    h.db = null; setup({ projects: 5, plan: 'pro' })
    const p = await call({ acknowledgeOverLimit: true })
    expect(p.status).toBe(409)
    expect(p.body.projectLimitExceeded).toBe(true)
    expect(h.db.tables.billing_checkouts || []).toHaveLength(0)
  })
  it('a failed usage read still fails closed for a lapsed workspace', async () => {
    h.lapsed = true
    h.db = createFakeSupabase({
      workspaces: [{ id: 'w1', plan_tier: 'solo' }], billing: [], billing_checkouts: [],
      users: [{ id: 'u1', email: 'owner@agency.test' }], workspace_members: members(4), projects: [],
    }, { errors: [{ table: 'workspace_members', op: 'select' }] })
    const r = await call({ acknowledgeOverLimit: true })
    expect(r.status).toBe(500)
    expect(h.db.tables.billing_checkouts || []).toHaveLength(0)
  })
})

describe('B3 — what a read-only workspace sees', () => {
  it('the app layout renders the LapsedBanner component with the billing flag', () => {
    const layout = read('app/(app)/layout.tsx')
    expect(layout).toMatch(/<LapsedBanner canManageBilling=\{session\.permissions\.includes\('MANAGE_BILLING'\)\} \/>/)
    expect(layout).not.toMatch(/banner banner-danger/)
  })
  it('the banner keeps its headline, and only people with billing access are offered the plan buttons', () => {
    const src = read('components/layout/LapsedBanner.tsx')
    expect(src).toMatch(/This workspace is read-only/)
    expect(src).toMatch(/canManageBilling && \(/)
    expect(src).toMatch(/Ask a workspace admin with billing access/)
    expect(src).toMatch(/href="\/settings\?tab=billing"/)
  })
  it('the Billing tab says "No active plan" instead of "Solo" for a lapsed workspace, and offers over-limit hints', () => {
    const src = read('components/settings/SettingsClient.tsx')
    expect(src).toMatch(/const lapsed: boolean = !!session\?\.lapsed/)
    expect(src).toMatch(/No active plan/)
    expect(src).toMatch(/overLimitAckRequired/)
    expect(src).toMatch(/acknowledgeOverLimit: true/)
    expect(src).toMatch(/You can still subscribe, then reduce afterwards\./)
  })
  it('the Team page no longer tells a read-only workspace to deactivate members it cannot deactivate', () => {
    const src = read('components/team/TeamClient.tsx')
    expect(src).toMatch(/session\.lapsed \? \(/)
    expect(src).toMatch(/This workspace has no active plan and is read-only/)
  })
})
