import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'
import { GRACE_DAYS, GRACE_REMINDER_DAYS_LEFT } from '@/lib/billing/plans'

const h = vi.hoisted(() => ({ db: null as any, reminders: [] as any[], alerts: [] as any[], heartbeats: [] as any[] }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async (...a: any[]) => { h.alerts.push(a) } }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async (_s: any, name: string) => { h.heartbeats.push(name) } }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async () => {} }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => [] }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [{ name: 'Bea', email: 'bea@agency.test' }] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => {} }))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async () => ({ ok: true }) }))
vi.mock('@/lib/email/templates', () => ({
  sendTrialWarningEmail: async () => {}, sendInvoiceOverdueInternalEmail: async () => {},
  sendPaymentMilestoneOverdueEmail: async () => {}, sendSubscriptionEndedEmail: async () => {},
  sendPaymentFailedEmail: async (p: any) => { h.reminders.push(p) },
}))
// Audit rows go into the fake's audit_log so the route's own "already reminded?" lookup sees them.
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ id: `a${h.db.tables.audit_log.length}`, created_at: new Date().toISOString(), ...row }); return true },
}))

import { POST } from '@/app/api/cron/payment-overdue/route'

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const billing = (workspaceId: string, graceStartedDaysAgo: number): Row => ({
  workspace_id: workspaceId, grace_period_started_at: ago(graceStartedDaysAgo),
  paystack_subscription_code: null, paystack_email_token: null,
  workspaces: { id: workspaceId, agency_name: `Agency ${workspaceId}`, plan_tier: 'studio', deleted_at: null, created_by: 'u1', creator: { name: 'Cee', email: 'cee@agency.test' } },
})
const run = async () => { const res = await POST({} as any); return { status: res.status, body: await res.json() } }
const REMINDER_POINT = GRACE_DAYS - GRACE_REMINDER_DAYS_LEFT // days into grace at which the reminder is due

beforeEach(() => {
  h.reminders.length = 0; h.alerts.length = 0; h.heartbeats.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('payment-overdue — grace-period reminder', () => {
  it('sends the reminder once a workspace reaches the reminder point, and only once (a re-run is a no-op)', async () => {
    h.db = createFakeSupabase({ billing: [billing('w1', REMINDER_POINT + 0.3)] })
    await run()
    expect(h.reminders).toHaveLength(1)
    expect(h.reminders[0]).toMatchObject({ to: 'bea@agency.test', graceDaysLeft: GRACE_REMINDER_DAYS_LEFT })
    await run()
    expect(h.reminders).toHaveLength(1)
  })

  it('CATCHES UP after a skipped or late run — a workspace past the old 24h window still gets its warning before enforcement', async () => {
    // Inside the grace period, beyond the reminder point by more than a day: the old [d, d+1) window would never have selected it.
    const startedDaysAgo = REMINDER_POINT + 1.4
    expect(startedDaysAgo).toBeLessThan(GRACE_DAYS)
    h.db = createFakeSupabase({ billing: [billing('w1', startedDaysAgo)] })
    await run()
    expect(h.reminders).toHaveLength(1)
  })

  it('does not remind before the reminder point', async () => {
    h.db = createFakeSupabase({ billing: [billing('w1', REMINDER_POINT - 0.5)] })
    await run()
    expect(h.reminders).toHaveLength(0)
  })

  it('a reminder logged for an EARLIER grace period does not suppress this one', async () => {
    h.db = createFakeSupabase({
      billing: [billing('w1', REMINDER_POINT + 0.3)],
      audit_log: [{ id: 'old', workspace_id: 'w1', event_type: 'billing.payment_failed_grace_reminder', created_at: ago(90) }],
    })
    await run()
    expect(h.reminders).toHaveLength(1)
  })

  it('a reminder logged during THIS grace period does suppress it', async () => {
    h.db = createFakeSupabase({
      billing: [billing('w1', REMINDER_POINT + 0.3)],
      audit_log: [{ id: 'mine', workspace_id: 'w1', event_type: 'billing.payment_failed_grace_reminder', created_at: ago(0.1) }],
    })
    await run()
    expect(h.reminders).toHaveLength(0)
  })

  it('a failed dedupe lookup is reported and does NOT send (it used to read as "not sent yet" and re-send every run)', async () => {
    h.db = createFakeSupabase({ billing: [billing('w1', REMINDER_POINT + 0.3)] }, { errors: [{ table: 'audit_log', op: 'select', message: 'db hiccup' }] })
    const { body } = await run()
    expect(h.reminders).toHaveLength(0)
    expect(body.rowErrors?.join(' ')).toMatch(/dedupe lookup failed/)
    expect(h.alerts).toHaveLength(1)
  })

  it('skips deleted workspaces', async () => {
    const b = billing('w1', REMINDER_POINT + 0.3); b.workspaces.deleted_at = ago(1)
    h.db = createFakeSupabase({ billing: [b] })
    await run()
    expect(h.reminders).toHaveLength(0)
  })
})
