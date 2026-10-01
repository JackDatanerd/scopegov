// tests/cron-section17-round6.test.ts
//
// Regression tests for the section-17 (cron) pass of round 6:
//   B1 — admin workspace restore left billing.cancels_at_period_end / needs_paystack_cancel set, and
//        cron/payment-overdue (step 5 / step 4b) then downgraded or cancelled a restored, paying workspace;
//        admin restore also resumed a subscription the OWNER had cancelled before the suspension.
//   B2 — healStuckSends ignored query errors, so approval-stall reported a green "healed: 0" while its recovery was broken.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any, alerts: [] as any[], resume: { ok: true } as any, resumeCalls: [] as any[], cancelResult: { ok: true, alreadyCancelled: false } as any,
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/admin', () => ({
  requireAdmin: async () => ({ actor: { id: 'admin1', email: 'admin@scopegov.app' }, service: h.db.client }),
  isAdminGuardFailure: (r: any) => !!r && 'status' in r && !('service' in r),
  logAdminAction: async () => true,
}))
vi.mock('@/lib/billing/ops-alert', () => ({
  alertBillingOps: async (_s: any, key: string, subject: string, lines: string[]) => { h.alerts.push({ key, subject, lines }); return true },
}))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => h.cancelResult,
  resumePaystackSubscription: async (b: any) => { h.resumeCalls.push(b); return h.resume },
}))
vi.mock('@/lib/email/templates', () => ({ sendWorkspaceSuspendedEmail: async () => ({ ok: true }), sendWorkspaceRestoredEmail: async () => ({ ok: true }) }))

import { POST as adminRestore } from '@/app/api/admin/workspaces/[id]/restore/route'
import { POST as adminSuspend } from '@/app/api/admin/workspaces/[id]/suspend/route'
import { healStuckSends } from '@/lib/approvals/engine'

const rpcOk = { admin_restore_workspace: () => ({ data: null, error: null }), admin_suspend_workspace: () => ({ data: true, error: null }) }
const restore = (id: string) => adminRestore({} as any, { params: { id } })
const suspend = (id: string) => adminSuspend({ json: async () => ({}) } as any, { params: { id } })
const billingOf = (id: string) => h.db.tables.billing.find((r: any) => r.workspace_id === id)

beforeEach(() => {
  h.alerts.length = 0; h.resumeCalls.length = 0; h.resume = { ok: true }; h.cancelResult = { ok: true, alreadyCancelled: false }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('B1 — admin restore clears the billing state the suspension left behind', () => {
  const seed = (billing: any, opts: any = {}) => createFakeSupabase({
    workspaces: [{ id: 'w1', name: 'W', agency_name: 'A', deleted_at: '2026-01-01T00:00:00Z', suspended_by_admin: true }],
    workspace_members: [],
    billing: [{ workspace_id: 'w1', paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok', ...billing }],
  }, { rpc: rpcOk, ...opts })

  it('clears cancels_at_period_end and the suspend marker after a successful resume (so step 5 cannot downgrade it)', async () => {
    h.db = seed({ cancels_at_period_end: true, cancelled_by_workspace_delete_at: '2026-01-01T00:00:00Z', needs_paystack_cancel: false })
    const res = await restore('w1')
    expect(res.status).toBe(200)
    expect(h.resumeCalls).toHaveLength(1)
    const row = billingOf('w1')
    expect(row.cancels_at_period_end).toBe(false)
    expect(row.cancelled_by_workspace_delete_at).toBeNull()
    expect(row.paystack_subscription_code).toBe('SUB_1')
    expect(h.alerts).toHaveLength(0)
  })

  it('clears needs_paystack_cancel (a failed suspend-cancel) so payment-overdue step 4b cannot cancel the re-enabled subscription', async () => {
    h.db = seed({ needs_paystack_cancel: true, cancels_at_period_end: false, cancelled_by_workspace_delete_at: null })
    await restore('w1')
    expect(billingOf('w1').needs_paystack_cancel).toBe(false)
    // the cancel may have reached Paystack with the response lost — resume is attempted (already-active counts as ok)
    expect(h.resumeCalls).toHaveLength(1)
  })

  it('does NOT resume a subscription the owner had cancelled before the suspension, and leaves their cancellation intact', async () => {
    h.db = seed({ cancels_at_period_end: true, cancelled_by_workspace_delete_at: null, needs_paystack_cancel: false })
    const res = await restore('w1')
    expect(res.status).toBe(200)
    expect(h.resumeCalls).toHaveLength(0)
    expect(billingOf('w1').cancels_at_period_end).toBe(true)
  })

  it('on a failed resume: alerts ops, keeps cancels_at_period_end and the marker, but still clears needs_paystack_cancel', async () => {
    h.db = seed({ cancels_at_period_end: true, cancelled_by_workspace_delete_at: '2026-01-01T00:00:00Z', needs_paystack_cancel: true })
    h.resume = { ok: false, error: 'Paystack unreachable' }
    const res = await restore('w1')
    expect(res.status).toBe(200)
    const row = billingOf('w1')
    expect(row.needs_paystack_cancel).toBe(false)
    expect(row.cancels_at_period_end).toBe(true)
    expect(row.cancelled_by_workspace_delete_at).toBeTruthy()
    expect(h.alerts.some(a => a.key === 'billing:restore-resume:w1')).toBe(true)
  })

  it('retries the local write once, and alerts when it still fails', async () => {
    h.db = seed({ cancels_at_period_end: true, cancelled_by_workspace_delete_at: '2026-01-01T00:00:00Z' }, {
      errors: [{ table: 'billing', op: 'update', when: (p: any) => p?.cancels_at_period_end === false, times: 2 }],
    })
    await restore('w1')
    expect(h.alerts.some(a => a.key === 'billing:restore-resume-local-write:w1')).toBe(true)
  })

  it('alerts (loudly) when needs_paystack_cancel cannot be cleared', async () => {
    h.db = seed({ needs_paystack_cancel: true }, {
      errors: [{ table: 'billing', op: 'update', when: (p: any) => p?.needs_paystack_cancel === false && !('cancels_at_period_end' in p), times: 1 }],
    })
    await restore('w1')
    expect(h.alerts.some(a => a.key === 'billing:restore-cancel-flag:w1')).toBe(true)
  })

  it('never touches a row whose subscription was replaced (guarded by the code that was read)', async () => {
    h.db = seed({ cancels_at_period_end: true, cancelled_by_workspace_delete_at: '2026-01-01T00:00:00Z' })
    // a plan switch lands after the read: simulate by changing the code on resume
    h.resume = { ok: true }
    const orig = h.db.client.from.bind(h.db.client)
    let swapped = false
    h.db.client.from = (t: string) => {
      if (t === 'billing' && h.resumeCalls.length && !swapped) { swapped = true; billingOf('w1').paystack_subscription_code = 'SUB_NEW'; billingOf('w1').cancels_at_period_end = false }
      return orig(t)
    }
    await restore('w1')
    expect(billingOf('w1').paystack_subscription_code).toBe('SUB_NEW')
    expect(billingOf('w1').cancelled_by_workspace_delete_at).toBeTruthy() // guard matched nothing — row untouched
  })

  it('a workspace with no subscription on file is restored without any Paystack call', async () => {
    h.db = seed({ paystack_subscription_code: null })
    const res = await restore('w1')
    expect(res.status).toBe(200)
    expect(h.resumeCalls).toHaveLength(0)
  })
})

describe('B1 — admin suspend records that the suspension cancelled the subscription', () => {
  const seed = (billing: any) => createFakeSupabase({
    workspaces: [{ id: 'w1', name: 'W', agency_name: 'A', deleted_at: null }],
    workspace_members: [],
    billing: [{ workspace_id: 'w1', paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok', ...billing }],
  }, { rpc: rpcOk })

  it('sets the marker when the suspend actually disabled the subscription', async () => {
    h.db = seed({}); h.cancelResult = { ok: true, alreadyCancelled: false }
    await suspend('w1')
    expect(billingOf('w1').cancelled_by_workspace_delete_at).toBeTruthy()
  })

  it('does not set it when the subscription was already cancelled by the owner', async () => {
    h.db = seed({}); h.cancelResult = { ok: true, alreadyCancelled: true }
    await suspend('w1')
    expect(billingOf('w1').cancelled_by_workspace_delete_at ?? null).toBeNull()
  })

  it('clears a stale marker left by an earlier delete/restore cycle when nothing was cancelled', async () => {
    h.db = seed({ cancelled_by_workspace_delete_at: '2025-01-01T00:00:00Z' }); h.cancelResult = { ok: true, alreadyCancelled: true }
    await suspend('w1')
    expect(billingOf('w1').cancelled_by_workspace_delete_at).toBeNull()
  })

  it('does not set it when the cancel failed (needs_paystack_cancel carries that case)', async () => {
    h.db = seed({}); h.cancelResult = { ok: false, error: 'down' }
    await suspend('w1')
    expect(billingOf('w1').cancelled_by_workspace_delete_at ?? null).toBeNull()
    expect(billingOf('w1').needs_paystack_cancel).toBe(true)
  })

  it('pages ops when the marker cannot be written', async () => {
    h.db = createFakeSupabase({
      workspaces: [{ id: 'w1', name: 'W', agency_name: 'A', deleted_at: null }], workspace_members: [],
      billing: [{ workspace_id: 'w1', paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok' }],
    }, { rpc: rpcOk, errors: [{ table: 'billing', op: 'update', when: (p: any) => 'cancelled_by_workspace_delete_at' in p, times: 2 }] })
    h.cancelResult = { ok: true, alreadyCancelled: false }
    const res = await suspend('w1')
    expect(res.status).toBe(200)
    expect(h.alerts.some(a => a.key === 'billing:suspend-marker:w1')).toBe(true)
  })
})

describe('B2 — healStuckSends reports errors instead of swallowing them', () => {
  const stuckRow = { id: 'r1', workspace_id: 'w1', requested_by: 'u1', project_id: 'p1', document_type: 'sow', context: { title: 'T' }, status: 'pending', sending_started_at: '2020-01-01T00:00:00Z' }
  const db = (opts: any = {}) => createFakeSupabase({ approval_requests: [stuckRow], notification_preferences: [], workspace_notification_defaults: [] }, opts)

  it('strict: a failed candidate lookup throws (so the cron step fails, alerts and withholds the heartbeat)', async () => {
    const d = db({ errors: [{ table: 'approval_requests', op: 'select' }] })
    await expect(healStuckSends(d.client, 10, undefined, { strict: true })).rejects.toThrow(/heal stuck sends select/)
  })

  it('non-strict (lazy heal on page load): a failed lookup is logged and returns [] instead of throwing', async () => {
    const d = db({ errors: [{ table: 'approval_requests', op: 'select' }] })
    await expect(healStuckSends(d.client, 10, 'w1')).resolves.toEqual([])
    expect((console.error as any).mock.calls.some((c: any[]) => String(c[0]).includes('could not list stuck sends'))).toBe(true)
  })

  it('a failing finalize RPC goes to onError and does not report the request as healed or stop the sweep', async () => {
    const d = db({ rpc: { finalize_approval_send: () => ({ data: null, error: { message: 'function does not exist' } }) } })
    const errs: Array<[string, any]> = []
    const healed = await healStuckSends(d.client, 10, undefined, { strict: true, onError: (l, e) => errs.push([l, e]) })
    expect(healed).toEqual([])
    expect(errs).toHaveLength(1)
    expect(errs[0][0]).toContain('r1')
  })

  it('without onError a failing RPC is logged, not silent', async () => {
    const d = db({ rpc: { finalize_approval_send: () => ({ data: null, error: { message: 'boom' } }) } })
    await healStuckSends(d.client)
    expect((console.error as any).mock.calls.some((c: any[]) => String(c[0]).includes('finalize_approval_send failed'))).toBe(true)
  })

  it('a successful heal is returned (and a concurrent resolve — rpc false — is skipped quietly)', async () => {
    const d = db({ rpc: { finalize_approval_send: () => ({ data: true, error: null }) } })
    const healed = await healStuckSends(d.client)
    expect(healed.map(r => r.id)).toEqual(['r1'])
    const d2 = db({ rpc: { finalize_approval_send: () => ({ data: false, error: null }) } })
    expect(await healStuckSends(d2.client)).toEqual([])
  })
})
