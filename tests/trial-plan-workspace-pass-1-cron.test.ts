// tests/trial-plan-workspace-pass-1-cron.test.ts
//
// Trial / plan change / multiple-workspaces independent pass — cron/payment-overdue step 2 (trial expiry).
// The day-0 "Your trial has ended" email went to every billing recipient regardless of the `trial_ending` preference
// that the 3/2/1-day warnings (cron/trial-warning) honour. It now applies the same filter, and the creator is passed
// WITH their user id so their own preference counts. The downgrade and its audit row do not depend on who is emailed.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  sent: [] as any[],
  audits: [] as any[],
  rowErrors: [] as string[],
  muted: new Set<string>(),
  filterCalls: [] as any[],
  extrasSeen: [] as any[],
}))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/utils/audit', () => ({ insertAuditRow: async (_s: any, row: any) => { h.audits.push(row); return true } }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async () => ({}) }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async () => ({ ok: true }) }))
vi.mock('@/lib/utils/money', () => ({ formatMoney: (n: any) => String(n) }))
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async (fn: any) => { await fn(); return { ok: true } } }))
// An explicit object, not a Proxy: vitest wraps a mock factory's result and throws "No X export is defined" for any
// name it cannot see as an own key, so a catch-all Proxy never reached `sendTrialWarningEmail` and no email was ever captured.
vi.mock('@/lib/email/templates', () => ({
  sendTrialWarningEmail: async (a: any) => { h.sent.push(a); return { ok: true } },
  sendPaymentFailedEmail: async () => ({ ok: true }),
  sendInvoiceOverdueInternalEmail: async () => ({ ok: true }),
  sendPaymentMilestoneOverdueEmail: async () => ({ ok: true }),
  sendSubscriptionEndedEmail: async () => ({ ok: true }),
}))
vi.mock('@/lib/utils/permissions-query', () => ({
  getMemberEmailsWithPermission: async () => [],
  filterByNotificationPreference: async (_s: any, ws: string, ev: string, r: any[]) => {
    h.filterCalls.push({ ws, ev })
    return r.filter(x => !h.muted.has(x.id))
  },
}))
vi.mock('@/lib/billing/recipients', () => ({
  getBillingRecipients: async (_s: any, _w: string, extras: any[]) => {
    h.extrasSeen = extras
    return [
      { id: 'u-holder', name: 'Hal', email: 'hal@x.test' },
      { id: 'u-muted', name: 'Mia', email: 'mia@x.test' },
      ...extras.filter(Boolean).map((e: any) => ({ id: e.id, name: e.name, email: e.email })),
    ]
  },
}))
vi.mock('@/lib/utils/cron-run', () => ({
  CronRun: class {
    result: Record<string, unknown> = {}
    constructor(..._a: any[]) {}
    async step(_n: string, fn: () => Promise<void>) { try { await fn() } catch { /* other steps are not under test */ } }
    rowError(label: string, e: unknown) { h.rowErrors.push(`${label}: ${(e as any)?.message}`) }
    async finish() { return { body: { ok: true }, status: 200 } }
  },
  fetchAll: async (label: string) => label === 'expired trials select' ? [{
    id: 'w1', agency_name: 'Acme', plan_tier: 'trial', created_by: 'u-creator', billing: null,
    trial_ends_at: new Date(Date.now() - 3_600_000).toISOString(),
    creator: { name: 'Cee', email: 'cee@x.test' },
  }] : [],
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: any = new Proxy({}, {
        get(_t, p: string) {
          if (p === 'then') return (res: any) => Promise.resolve({ data: table === 'workspaces' ? [{ id: 'w1' }] : [], error: null }).then(res)
          return () => q
        },
      })
      return q
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}))

import { POST } from '@/app/api/cron/payment-overdue/route'

beforeEach(() => {
  h.sent.length = 0; h.audits.length = 0; h.rowErrors.length = 0; h.filterCalls.length = 0; h.extrasSeen = []
  h.muted.clear(); h.muted.add('u-muted')
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('payment-overdue step 2: trial expiry email audience', () => {
  it('does not email a member who muted trial_ending, but still emails the holder and the creator', async () => {
    await POST({} as any)
    expect(h.sent.map(s => s.to).sort()).toEqual(['cee@x.test', 'hal@x.test'])
    expect(h.sent.every(s => s.daysLeft === 0 && s.agencyName === 'Acme' && s.upgradeUrl === 'https://app.test/settings?tab=billing')).toBe(true)
    expect(h.filterCalls).toEqual([{ ws: 'w1', ev: 'trial_ending' }])
  })

  it('passes the creator with their user id so their own preference applies', async () => {
    await POST({} as any)
    expect(h.extrasSeen[0]).toEqual({ name: 'Cee', email: 'cee@x.test', id: 'u-creator' })
    h.sent.length = 0
    h.muted.add('u-creator')
    await POST({} as any)
    expect(h.sent.map(s => s.to)).toEqual(['hal@x.test'])
  })

  it('the downgrade audit row is written regardless of who is emailed', async () => {
    h.muted.add('u-creator'); h.muted.add('u-holder')
    await POST({} as any)
    expect(h.sent).toHaveLength(0)
    expect(h.audits.filter(a => a.event_type === 'billing.trial_expired')).toHaveLength(1)
    expect(h.rowErrors).toEqual([])
  })
})
