// tests/trial-subscription-end-lapse.test.ts
//
// Trial / subscription end pass:
//   - option 2 (no free Solo): a workspace with no subscription that nobody comped is LAPSED = read-only
//   - B1: the period-end sweep (step 5) leaves no payment-failure grace clock behind

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isWorkspaceLapsed, LAPSED_KEEP_PERMISSIONS } from '@/lib/billing/plans'
import { ALL_PERMISSIONS } from '@/lib/supabase/types'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, emails: [] as string[] }))
vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async () => {} }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async () => true }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => [], filterByNotificationPreference: async (_s: any, _w: any, _e: string, r: any[]) => r }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [{ name: 'Ann', email: 'ann@x.test' }] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async () => ({ ok: true }) }))
vi.mock('@/lib/email/templates', () => ({
  sendTrialWarningEmail: async () => { h.emails.push('trial'); return { ok: true } },
  sendInvoiceOverdueInternalEmail: async () => ({ ok: true }), sendPaymentMilestoneOverdueEmail: async () => ({ ok: true }),
  sendSubscriptionEndedEmail: async (p: any) => { h.emails.push(`ended:${p.reason ?? 'cancelled'}`); return { ok: true } },
  sendPaymentFailedEmail: async () => { h.emails.push('failed'); return { ok: true } },
}))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => {
    h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ id: `a${h.db.tables.audit_log.length}`, created_at: new Date().toISOString(), ...row }); return true
  },
}))

import { POST as paymentOverdue } from '@/app/api/cron/payment-overdue/route'

const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const call = async () => { const res = await paymentOverdue({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  h.emails.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('isWorkspaceLapsed', () => {
  it('an explicit lapsed_at always lapses', () => expect(isWorkspaceLapsed('solo', null, ago(1))).toBe(true))
  it('an expired stored trial lapses at once, before the cron runs', () => expect(isWorkspaceLapsed('trial', ago(1), null)).toBe(true))
  it('a running trial, and paid or comped plans, do not', () => {
    expect(isWorkspaceLapsed('trial', new Date(Date.now() + DAY).toISOString(), null)).toBe(false)
    expect(isWorkspaceLapsed('pro', null, null)).toBe(false)
    expect(isWorkspaceLapsed('solo', null, null)).toBe(false) // staff-comped / grandfathered Solo is NOT lapsed
  })
  it('a trial with no end date is never lapsed (missing data never locks anyone)', () => expect(isWorkspaceLapsed('trial', null, null)).toBe(false))
})

describe('read-only permission set', () => {
  it('keeps viewing, exports, billing and settings; drops every writing permission', () => {
    const kept = ALL_PERMISSIONS.filter(p => LAPSED_KEEP_PERMISSIONS.has(p))
    for (const p of ['VIEW_OWN_PROJECTS', 'VIEW_ALL_PROJECTS', 'VIEW_FINANCIALS', 'VIEW_AUDIT_LOG', 'MANAGE_BILLING']) expect(kept).toContain(p)
    for (const p of ['CREATE_PROJECTS', 'EDIT_SOW', 'SEND_SOW', 'SEND_CHANGE_ORDERS', 'SEND_INVOICES', 'INVITE_MEMBERS', 'APPROVE_DOCUMENTS', 'DELETE_PROJECTS'])
      expect(kept).not.toContain(p)
  })
})

describe('payment-overdue marks every end of a subscription as lapsed', () => {
  const ws = (over: Row = {}) => ({ id: 'w1', agency_name: 'A', plan_tier: 'pro', deleted_at: null, created_by: 'u1', creator: null, ...over })

  it('step 2: an expired trial becomes Solo AND lapsed', async () => {
    h.db = createFakeSupabase({ workspaces: [{ id: 'w1', agency_name: 'A', plan_tier: 'trial', trial_ends_at: ago(1), deleted_at: null, created_by: 'u1', creator: null, billing: null, lapsed_at: null }] })
    await call()
    expect(h.db.tables.workspaces[0].plan_tier).toBe('solo')
    expect(h.db.tables.workspaces[0].lapsed_at).toBeTruthy()
  })

  it('step 4: grace enforcement lapses the workspace', async () => {
    h.db = createFakeSupabase({
      billing: [{ workspace_id: 'w1', grace_period_started_at: ago(6), paystack_subscription_code: null, workspaces: ws() }],
      workspaces: [{ id: 'w1', plan_tier: 'pro', lapsed_at: null }],
    })
    await call()
    expect(h.db.tables.workspaces[0].lapsed_at).toBeTruthy()
  })

  it('step 5: a cancelled subscription past its period lapses the workspace', async () => {
    h.db = createFakeSupabase({
      billing: [{ workspace_id: 'w1', cancels_at_period_end: true, current_period_end: ago(1), paystack_subscription_code: 'S', paystack_customer_code: 'C', grace_period_started_at: null, workspaces: ws() }],
      workspaces: [{ id: 'w1', plan_tier: 'pro', lapsed_at: null }],
    })
    await call()
    expect(h.db.tables.workspaces[0].plan_tier).toBe('solo')
    expect(h.db.tables.workspaces[0].lapsed_at).toBeTruthy()
  })
})

describe('B1 — the period-end sweep clears the grace clock, so nothing fires twice', () => {
  const ws = (over: Row = {}) => ({ id: 'w1', agency_name: 'A', plan_tier: 'pro', deleted_at: null, created_by: 'u1', creator: null, ...over })

  it('a workspace cancelled during a payment-failure grace is ended once: no reminder, no second downgrade, no non-payment email', async () => {
    h.db = createFakeSupabase({
      billing: [{
        workspace_id: 'w1', cancels_at_period_end: true, current_period_end: ago(1), grace_period_started_at: ago(1),
        paystack_subscription_code: 'S', paystack_customer_code: 'C', workspaces: ws(),
      }],
      workspaces: [{ id: 'w1', plan_tier: 'pro', lapsed_at: null }],
    })
    await call() // day 0: step 5 ends the subscription
    expect(h.db.tables.billing[0].grace_period_started_at).toBeNull()
    expect(h.emails).toEqual(['ended:cancelled'])
    // the next daily runs must find nothing left to do
    h.emails.length = 0
    h.db.tables.billing[0].workspaces = ws({ plan_tier: 'solo' })
    await call(); await call()
    expect(h.emails).toEqual([])
    expect((h.db.tables.audit_log || []).filter((r: Row) => r.event_type === 'billing.downgraded_for_nonpayment')).toHaveLength(0)
  })
})
