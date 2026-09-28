// tests/admin-suspend-billing.test.ts
//
// FIX (deep audit, Billing re-pass — independent redo #4): a failed Paystack cancel on admin
// suspend used to end at console.error — no needs_paystack_cancel flag, no ops alert — and
// billing-reconcile explicitly excludes workspaces with deleted_at set (which suspend stamps),
// so the failure had no automated path to ever be noticed or retried. Verifies the fix: a
// failure now flags needs_paystack_cancel (picked up by payment-overdue's step 4b, whose query
// is not joined to workspaces and so retries regardless of deleted_at) and pages ops; a success
// does neither.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, alerts: [] as any[], cancelResult: null as any }))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/admin', () => ({
  requireAdmin: async () => ({ actor: { id: 'admin1', email: 'admin@scopegov.app' }, service: h.db.client }),
  isAdminGuardFailure: (r: any) => !!r && 'status' in r && !('service' in r),
  logAdminAction: async () => true,
}))
vi.mock('@/lib/billing/ops-alert', () => ({
  alertBillingOps: async (_s: any, key: string, subject: string, lines: string[]) => { h.alerts.push({ key, subject, lines }); return true },
}))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async () => h.cancelResult }))
vi.mock('@/lib/email/templates', () => ({ sendWorkspaceSuspendedEmail: async () => {} }))

import { POST } from '@/app/api/admin/workspaces/[id]/suspend/route'

const seed = (): Row[] => ([])

beforeEach(() => {
  h.alerts.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const runSuspend = (id: string) => POST({ json: async () => ({}) } as any, { params: { id } })

describe('admin workspace suspend — Paystack cancel failure handling', () => {
  it('flags needs_paystack_cancel and pages ops when the Paystack cancel fails', async () => {
    h.db = createFakeSupabase({
      workspaces: [{ id: 'w1', name: 'W1', agency_name: 'Agency 1', deleted_at: null }],
      workspace_members: [],
      billing: [{ workspace_id: 'w1', paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok', needs_paystack_cancel: false }],
    }, { rpc: { admin_suspend_workspace: () => ({ data: true, error: null }) } })
    h.cancelResult = { ok: false, error: 'Paystack unreachable' }

    const res = await runSuspend('w1')
    expect(res.status).toBe(200)

    const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w1')
    expect(row.needs_paystack_cancel).toBe(true)
    expect(h.alerts.some(a => a.key === 'billing:orphan-sub:w1')).toBe(true)
  })

  it('does not flag or alert when there is no subscription on file to cancel', async () => {
    h.db = createFakeSupabase({
      workspaces: [{ id: 'w2', name: 'W2', agency_name: 'Agency 2', deleted_at: null }],
      workspace_members: [],
      billing: [{ workspace_id: 'w2', paystack_subscription_code: null, paystack_email_token: null, needs_paystack_cancel: false }],
    }, { rpc: { admin_suspend_workspace: () => ({ data: true, error: null }) } })
    h.cancelResult = { ok: true, alreadyCancelled: true }

    const res = await runSuspend('w2')
    expect(res.status).toBe(200)

    const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w2')
    expect(row.needs_paystack_cancel).toBe(false)
    expect(h.alerts).toHaveLength(0)
  })

  it('does not flag or alert on a successful cancel', async () => {
    h.db = createFakeSupabase({
      workspaces: [{ id: 'w3', name: 'W3', agency_name: 'Agency 3', deleted_at: null }],
      workspace_members: [],
      billing: [{ workspace_id: 'w3', paystack_subscription_code: 'SUB_3', paystack_email_token: 'tok', needs_paystack_cancel: false }],
    }, { rpc: { admin_suspend_workspace: () => ({ data: true, error: null }) } })
    h.cancelResult = { ok: true, alreadyCancelled: false }

    const res = await runSuspend('w3')
    expect(res.status).toBe(200)

    const row = h.db.tables.billing.find((r: any) => r.workspace_id === 'w3')
    expect(row.needs_paystack_cancel).toBe(false)
    expect(h.alerts).toHaveLength(0)
  })
})

void seed
