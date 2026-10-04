// tests/trial-plan-workspace-pass-1-routes.test.ts
//
// Trial / plan change / multiple-workspaces independent pass — route-level.
//   * admin change-plan -> trial and admin restore: one_active_trial_per_creator is a 409 with a message, not a generic 500.
//   * billing/status reports the EFFECTIVE plan tier, matching the Billing tab and every gate (an expired trial is Solo).
//   * getBillingRecipients keeps each recipient's user id so a per-person preference can be applied.
//   * source guards for the two UI edits (Sidebar label/bar, Settings effective tier) that have no runnable harness here.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const h = vi.hoisted(() => ({
  svc: null as any,
  logged: [] as any[],
  audits: [] as any[],
  session: { workspaceId: 'w1' } as any,
  wsRow: null as any,
  holders: [] as any[],
}))

vi.mock('@/lib/auth/admin', () => ({
  requireAdmin: async () => ({ actor: { id: 'staff' }, service: h.svc }),
  isAdminGuardFailure: () => false,
  logAdminAction: async (_s: any, row: any) => { h.logged.push(row); return true },
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, row: any) => { h.audits.push(row); return true } }))
vi.mock('@/lib/integrations/paystack', () => ({ resumePaystackSubscription: async () => ({ ok: true, skipped: true }) }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/email/templates', () => ({ sendWorkspaceRestoredEmail: async () => ({ ok: true }) }))
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session, hasPermission: () => true }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: any = {}
      q.select = () => q
      q.eq = () => q
      q.maybeSingle = async () => table === 'workspaces'
        ? { data: h.wsRow, error: null }
        : { data: { plan_interval: 'monthly', paystack_subscription_code: null }, error: null }
      return q
    },
  }),
}))
vi.mock('@/lib/utils/permissions-query', () => ({ getMembersWithPermission: async () => h.holders }))

import { POST as changePlan } from '@/app/api/admin/workspaces/[id]/change-plan/route'
import { POST as restore } from '@/app/api/admin/workspaces/[id]/restore/route'
import { GET as billingStatus } from '@/app/api/billing/status/route'
import { getBillingRecipients } from '@/lib/billing/recipients'

const TRIAL_CONFLICT = { code: '23505', message: 'duplicate key value violates unique constraint "one_active_trial_per_creator"' }

// Scripted admin-side client: reads of `workspaces` return `ws`; the plan UPDATE returns `update`; the restore RPC returns `rpc`.
function adminSvc(script: { ws: any; update?: { data: any; error: any }; rpc?: { error: any } }) {
  return {
    from(table: string) {
      const q: any = { op: 'select' }
      for (const m of ['eq', 'is', 'not', 'in', 'order', 'limit', 'select']) q[m] = () => q
      q.update = () => { q.op = 'update'; return q }
      q.maybeSingle = async () => table === 'workspaces' ? { data: script.ws, error: null } : { data: null, error: null }
      q.then = (res: any, rej: any) => Promise.resolve(
        table === 'workspaces' && q.op === 'update' ? (script.update ?? { data: [{ id: 'w1' }], error: null }) : { data: [], error: null },
      ).then(res, rej)
      return q
    },
    rpc: async () => script.rpc ?? { error: null },
  }
}
const req = (body: any) => ({ json: async () => body }) as any
const ctx = { params: { id: 'w1' } }
const liveSolo = { id: 'w1', name: 'W', agency_name: 'Acme', plan_tier: 'solo', deleted_at: null }
const suspended = (adminSuspended: boolean) => ({ id: 'w1', name: 'W', agency_name: 'Acme', deleted_at: '2026-09-01T00:00:00Z', suspended_by_admin: adminSuspended })

beforeEach(() => {
  h.logged.length = 0; h.audits.length = 0; h.holders = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('admin change-plan -> trial', () => {
  it('explains a one-active-trial conflict (409) instead of a generic 500, and writes no audit', async () => {
    h.svc = adminSvc({ ws: liveSolo, update: { data: null, error: TRIAL_CONFLICT } })
    const res = await changePlan(req({ plan: 'trial' }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/another active trial/)
    expect(h.logged).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })
  it('any other write failure is still the generic 500 (other index, or a non-trial target)', async () => {
    h.svc = adminSvc({ ws: liveSolo, update: { data: null, error: { code: '23505', message: 'violates "workspaces_slug_key"' } } })
    expect((await changePlan(req({ plan: 'trial' }), ctx)).status).toBe(500)
    h.svc = adminSvc({ ws: liveSolo, update: { data: null, error: TRIAL_CONFLICT } })
    expect((await changePlan(req({ plan: 'pro' }), ctx)).status).toBe(500)
  })
  it('the normal path is untouched', async () => {
    h.svc = adminSvc({ ws: liveSolo })
    const res = await changePlan(req({ plan: 'trial', trialDays: 30 }), ctx)
    expect(res.status).toBe(200)
    expect(h.logged).toHaveLength(1)
    expect(h.audits[0].metadata.trial_days).toBe(30)
  })
})

describe('admin restore of a suspended trial workspace', () => {
  it('a one-active-trial conflict is a 409 trial_conflict, not a generic 500', async () => {
    h.svc = adminSvc({ ws: suspended(true), rpc: { error: TRIAL_CONFLICT } })
    const res = await restore(req({}), ctx)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('trial_conflict')
    expect(body.error).toMatch(/another active trial/)
  })
  it('other RPC failures and the self-deleted confirmation gate are unchanged', async () => {
    h.svc = adminSvc({ ws: suspended(true), rpc: { error: { code: 'XX000', message: 'kaboom' } } })
    const res = await restore(req({}), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Could not restore workspace')
    h.svc = adminSvc({ ws: suspended(false), rpc: { error: null } })
    const gated = await restore(req({}), ctx)
    expect(gated.status).toBe(409)
    expect((await gated.json()).code).toBe('self_deleted')
  })
})

describe('GET /api/billing/status reports the effective tier', () => {
  const day = 86_400_000
  it('an expired trial the cron has not downgraded yet reads as solo (matches the Billing tab and every gate)', async () => {
    h.wsRow = { plan_tier: 'trial', trial_ends_at: new Date(Date.now() - day).toISOString() }
    expect((await (await billingStatus()).json()).planTier).toBe('solo')
  })
  it('a live trial, a paid tier (even with a stale trial date) and a missing row', async () => {
    h.wsRow = { plan_tier: 'trial', trial_ends_at: new Date(Date.now() + 5 * day).toISOString() }
    expect((await (await billingStatus()).json()).planTier).toBe('trial')
    h.wsRow = { plan_tier: 'pro', trial_ends_at: new Date(Date.now() - day).toISOString() }
    expect((await (await billingStatus()).json()).planTier).toBe('pro')
    h.wsRow = null
    expect((await (await billingStatus()).json()).planTier).toBeNull()
  })
})

describe('getBillingRecipients keeps user ids', () => {
  it('holders carry their id; an extra carries one only if supplied; duplicates keep the holder; dead addresses drop', async () => {
    h.holders = [{ id: 'h1', name: 'Hal', email: 'hal@x.test' }, { id: 'h2', name: 'Gone', email: 'x@deleted.scopegov.app' }]
    const r = await getBillingRecipients({}, 'w1', [
      { id: 'creator', name: 'Cee', email: 'cee@x.test' },
      { id: 'dupe', name: 'Dupe', email: 'HAL@x.test' },
      { name: 'Payer', email: 'payer@x.test' },
      null, undefined,
    ])
    expect(r).toEqual([
      { name: 'Hal', email: 'hal@x.test', id: 'h1' },
      { name: 'Cee', email: 'cee@x.test', id: 'creator' },
      { name: 'Payer', email: 'payer@x.test' },
    ])
  })
})

describe('UI source guards', () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')
  it('Sidebar no longer hardcodes a 14-day denominator', () => {
    const src = read('components/layout/Sidebar.tsx')
    expect(src).not.toMatch(/of 14 trial days/)
    expect(src).not.toMatch(/daysLeft \/ 14/)
    expect(src).toMatch(/trialBarPercent\(daysLeft\)/)
  })
  it('Settings hands the Billing tab the effective plan tier', () => {
    expect(read('app/(app)/settings/page.tsx')).toMatch(/plan_tier:\s*session\.planTier/)
  })
})
