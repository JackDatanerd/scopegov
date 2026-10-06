// tests/trial-subscription-end-pass2.test.ts
//
// Independent re-pass on trial / subscription end:
//   B2  a read-only (lapsed) workspace can still SETTLE what already exists (withdraw/close/accept-counter/void/record
//       payment/resolve dispute) but still cannot create or send anything new
//   B3  staff can unlock a lapsed Solo workspace; the trial plan cannot be put on a workspace with a live subscription
//   lows  no "payment failed" warning for a subscription that is about to be / has been ended; no approval nags when lapsed

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()

const h = vi.hoisted(() => ({ db: null as any, session: null as any, emails: [] as string[], adminWs: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client, createServerSupabaseClient: async () => h.db.client }))
vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async () => {} }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async () => {} }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async () => true }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => [], filterByNotificationPreference: async (_s: any, _w: any, _e: string, r: any[]) => r }))
vi.mock('@/lib/billing/recipients', () => ({ getBillingRecipients: async () => [{ name: 'Ann', email: 'ann@x.test' }] }))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/integrations/paystack', () => ({ cancelPaystackSubscription: async () => ({ ok: true }) }))
vi.mock('@/lib/email/templates', async (orig) => ({
  ...(await orig() as object),
  sendTrialWarningEmail: async () => { h.emails.push('trial'); return { ok: true } },
  sendInvoiceOverdueInternalEmail: async () => ({ ok: true }), sendPaymentMilestoneOverdueEmail: async () => ({ ok: true }),
  sendSubscriptionEndedEmail: async (p: any) => { h.emails.push(`ended:${p.reason ?? 'cancelled'}`); return { ok: true } },
  sendPaymentFailedEmail: async () => { h.emails.push('failed'); return { ok: true } },
}))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ id: `a${h.db.tables.audit_log.length}`, created_at: new Date().toISOString(), ...row }); return true },
  logAudit: async () => true,
}))
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig() as object), getSession: async () => h.session }))
vi.mock('@/lib/auth/admin', () => ({
  requireAdmin: async () => ({ actor: { id: 'adm', email: 'a@x.test' }, service: h.db.client }),
  isAdminGuardFailure: () => false,
  logAdminAction: async () => true,
}))

import { hasPermission, hasSettlementPermission } from '@/lib/auth/session'
import { POST as paymentOverdue } from '@/app/api/cron/payment-overdue/route'
import { POST as voidInvoice } from '@/app/api/invoices/[id]/void/route'
import { POST as sendInvoice } from '@/app/api/invoices/[id]/send/route'
import { POST as changePlan } from '@/app/api/admin/workspaces/[id]/change-plan/route'

const sess = (over: Row = {}): any => ({
  id: 'u1', workspaceId: 'w1', email: 'o@x.test', name: 'Owner', agencyName: 'A', planTier: 'solo',
  permissions: ['VIEW_FINANCIALS', 'MANAGE_BILLING'], lapsed: true, lapsedWithheld: ['SEND_INVOICES', 'SEND_SOW', 'SEND_CHANGE_ORDERS', 'EDIT_SOW'], ...over,
})

describe('B2 — hasSettlementPermission', () => {
  it('a lapsed member who held the send permission may settle, but hasPermission still says no', () => {
    const s = sess()
    expect(hasPermission(s, 'SEND_INVOICES')).toBe(false)
    expect(hasSettlementPermission(s, 'SEND_INVOICES')).toBe(true)
    expect(hasSettlementPermission(s, 'SEND_SOW')).toBe(true)
    expect(hasSettlementPermission(s, 'SEND_CHANGE_ORDERS')).toBe(true)
  })

  it('never widens anything else: only the three send permissions, only if the member held them', () => {
    const s = sess()
    expect(hasSettlementPermission(s, 'EDIT_SOW')).toBe(false)               // withheld, but not a settlement permission
    expect(hasSettlementPermission(s, 'CREATE_PROJECTS')).toBe(false)
    expect(hasSettlementPermission(sess({ lapsedWithheld: [] }), 'SEND_INVOICES')).toBe(false)   // never held it
  })

  it('a workspace that is not lapsed behaves exactly as before', () => {
    expect(hasSettlementPermission(sess({ lapsed: false, permissions: ['SEND_INVOICES'], lapsedWithheld: [] }), 'SEND_INVOICES')).toBe(true)
    expect(hasSettlementPermission(sess({ lapsed: false, permissions: [], lapsedWithheld: ['SEND_INVOICES'] }), 'SEND_INVOICES')).toBe(false)
  })
})

describe('B2 — routes', () => {
  const ID = '11111111-1111-4111-8111-111111111111'
  const ctx = { params: Promise.resolve({ id: ID }) }
  const req = () => new Request('http://x.test/api', { method: 'POST', body: '{}' }) as any
  beforeEach(() => { h.db = createFakeSupabase({ invoices: [] }); vi.spyOn(console, 'error').mockImplementation(() => {}) })

  it('void invoice (settlement): a lapsed member gets past the permission gate; one who never held it does not', async () => {
    h.session = sess()
    expect((await voidInvoice(req(), ctx)).status).toBe(404)                       // reached the lookup — not 403
    h.session = sess({ lapsedWithheld: [] })
    expect((await voidInvoice(req(), ctx)).status).toBe(403)
  })

  it('send invoice (creating/sending new): still blocked on a lapsed workspace', async () => {
    h.session = sess()
    expect((await sendInvoice(req(), ctx)).status).toBe(403)
  })

  const SETTLE = [
    'app/api/sow/[id]/withdraw/route.ts', 'app/api/co/[id]/withdraw/route.ts', 'app/api/co/[id]/close/route.ts',
    'app/api/co/[id]/accept-counter/route.ts', 'app/api/invoices/[id]/void/route.ts', 'app/api/invoices/[id]/dispute-resolve/route.ts',
    'app/api/invoices/[id]/payments/route.ts', 'app/api/invoices/[id]/payments/[paymentId]/route.ts',
  ]
  const NEW_WORK = [
    'app/api/sow/[id]/send/route.ts', 'app/api/sow/[id]/remind/route.ts', 'app/api/sow/[id]/link/route.ts',
    'app/api/co/[id]/send/route.ts', 'app/api/co/[id]/revise/route.ts', 'app/api/co/[id]/remind/route.ts', 'app/api/co/[id]/escalate/route.ts',
    'app/api/invoices/[id]/send/route.ts', 'app/api/invoices/[id]/remind/route.ts', 'app/api/invoices/draft/route.ts', 'app/api/invoices/route.ts',
  ]
  it('every settlement route uses the settlement check; nothing that creates or sends new work does', () => {
    for (const f of SETTLE) expect(read(f), f).toMatch(/hasSettlementPermission\(session, 'SEND_/)
    for (const f of NEW_WORK) expect(read(f), f).not.toMatch(/hasSettlementPermission/)
  })

  it('the buttons follow: settle flags reach the UI, and only the settlement buttons use them', () => {
    const page = read('app/(app)/projects/[id]/page.tsx')
    for (const k of ['settleSow', 'settleCo', 'settleInvoices']) expect(page).toMatch(new RegExp(`${k}: hasSettlementPermission`))
    const pd = read('components/projects/ProjectDetail.tsx')
    expect(pd).toMatch(/co\.status === 'countered' && permissions\.settleCo && !pendingApproval/)          // accept counter
    expect(pd).toMatch(/\['countered','stalled','declined','expired','draft'\]\.includes\(co\.status\) && permissions\.settleCo/) // close
    expect(pd).toMatch(/awaiting_signature' && \(permissions\.sendSow \|\| permissions\.settleSow\)/)    // SOW withdraw group
    expect(pd).toMatch(/\{permissions\.sendSow && \(\s*<button className="btn btn-ghost btn-sm" onClick=\{handleRemind\}/)  // Remind stays send-only
    const bt = read('components/invoices/BillingTab.tsx')
    expect(bt).toMatch(/permissions\.settleInvoices && \(\s*<button className="btn btn-ghost btn-sm" onClick=\{\(\) => setPayingId/) // record payment
    expect(bt).toMatch(/permissions\.settleInvoices && \(\s*<button className="btn btn-ghost btn-sm" style=\{\{ color: 'var\(--red\)' \}\} onClick=\{\(\) => setVoidingId/) // void
  })
})

describe('B3 — admin change-plan', () => {
  const call = (plan: string) => changePlan(new Request('http://x.test', { method: 'POST', body: JSON.stringify({ plan }) }) as any, { params: { id: 'w1' } })
  const setup = (ws: Row, billing: Row[] = []) => { h.db = createFakeSupabase({ workspaces: [{ id: 'w1', name: 'A', agency_name: 'A', deleted_at: null, trial_ends_at: null, ...ws }], billing, workspace_members: [], users: [] }) }
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) })

  it('a lapsed Solo workspace CAN be set to Solo (comp / unlock) and comes back writable', async () => {
    setup({ plan_tier: 'solo', lapsed_at: ago(3) })
    const res = await call('solo')
    expect(res.status).toBe(200)
    expect(h.db.tables.workspaces[0].lapsed_at).toBeNull()
    expect(h.db.tables.workspaces[0].plan_tier).toBe('solo')
  })

  it('a workspace that is not lapsed is still refused the plan it is already on', async () => {
    setup({ plan_tier: 'solo', lapsed_at: null })
    expect((await call('solo')).status).toBe(409)
  })

  it('the trial plan is refused while a Paystack subscription is live, and allowed once there is none', async () => {
    setup({ plan_tier: 'pro', lapsed_at: null }, [{ workspace_id: 'w1', paystack_subscription_code: 'SUB_1' }])
    const blocked = await call('trial')
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error).toMatch(/live Paystack subscription/)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('pro')
    setup({ plan_tier: 'pro', lapsed_at: null }, [{ workspace_id: 'w1', paystack_subscription_code: null }])
    expect((await call('trial')).status).toBe(200)
  })

  it('the admin page shows the lapsed state and offers the current plan only when it is lapsed', () => {
    const page = read('app/(admin)/admin/workspaces/[id]/page.tsx')
    expect(page).toMatch(/Lapsed — read-only since/)
    expect(page).toMatch(/p !== workspace\.plan_tier \|\| !!workspace\.lapsed_at/)
    expect(read('app/api/admin/workspaces/[id]/route.ts')).toMatch(/plan_tier, lapsed_at/)
  })
})

describe('lows', () => {
  const call = async () => { const res = await paymentOverdue({} as any); return res.status }
  const ws = (over: Row = {}) => ({ id: 'w1', agency_name: 'A', plan_tier: 'pro', deleted_at: null, created_by: 'u1', creator: null, ...over })
  beforeEach(() => {
    h.emails.length = 0
    for (const k of ['error', 'log', 'warn'] as const) vi.spyOn(console, k).mockImplementation(() => {})
  })

  it('a cancelled subscription whose period is over gets ONE ending notice — not a "payment failed" warning in the same run', async () => {
    h.db = createFakeSupabase({
      billing: [{ workspace_id: 'w1', grace_period_started_at: ago(3), cancels_at_period_end: true, current_period_end: ago(1), paystack_subscription_code: 'S', paystack_customer_code: 'C', workspaces: ws() }],
      workspaces: [{ id: 'w1', plan_tier: 'pro', lapsed_at: null }],
    })
    await call()
    expect(h.emails).toEqual(['ended:cancelled'])
  })

  it('control: a genuine payment-failure grace (not cancelled) still gets its reminder', async () => {
    h.db = createFakeSupabase({
      billing: [{ workspace_id: 'w1', grace_period_started_at: ago(3), cancels_at_period_end: false, current_period_end: ago(1), paystack_subscription_code: 'S', paystack_customer_code: 'C', workspaces: ws() }],
      workspaces: [{ id: 'w1', plan_tier: 'pro', lapsed_at: null }],
    })
    await call()
    expect(h.emails).toEqual(['failed'])
  })

  it('approval-stall skips lapsed workspaces in both of its sweeps', () => {
    const src = read('app/api/cron/approval-stall/route.ts')
    expect(src.match(/\.is\('workspaces\.lapsed_at', null\)/g)).toHaveLength(2)
    expect(src.match(/workspaces!inner\(deleted_at, lapsed_at\)/g)).toHaveLength(2)
  })
})

describe('homepage', () => {
  it('the calculator is reachable from the hero, the closing call to action, the nav and the footer', () => {
    const home = read('components/marketing/MarketingHome.tsx')
    expect(home.match(/href="\/calculator"/g)!.length).toBeGreaterThanOrEqual(3)   // hero + final CTA + pricing note
    expect(home).toMatch(/styles\.btnGhost\} \$\{styles\.btnLg\}`\}>Estimate your scope loss/)
    expect(home).toMatch(/styles\.btnOnDark\} \$\{styles\.btnLg\}`\}>Estimate your scope loss/)
    expect(read('components/marketing/MarketingHeader.tsx')).toContain('href="/calculator"')
    expect(read('components/marketing/MarketingFooter.tsx')).toContain('href="/calculator"')
  })
})
