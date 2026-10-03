// tests/admin-panel-audit.test.ts
//
// Admin panel, independent audit round 1. One regression test per finding that can be exercised without a browser or a
// live database; the pure helpers are tested directly, and B1 / B8 / B9 (which are about how pages and queries are
// WRITTEN) are guarded structurally so a new admin page cannot quietly regress them.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any,
  service: null as any,
  audits: [] as any[],
  auditResult: true,
  paystackCalls: 0,
  emails: 0,
}))

vi.mock('@/lib/auth/admin', () => ({
  requireAdmin: async () => ({ actor: { id: 'admin1', email: 'admin@scopegov.app', name: 'Admin' }, service: h.service }),
  isAdminGuardFailure: (r: any) => !!r && 'status' in r && !('service' in r),
  logAdminAction: async (_s: any, p: any) => { h.audits.push(p); return h.auditResult },
  logAdminRead: async () => true,
  loadAdminHistory: async () => [],
}))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: async () => true }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: async () => { h.paystackCalls++; return { ok: true, alreadyCancelled: true } },
  resumePaystackSubscription: async () => { h.paystackCalls++; return { ok: true } },
}))
vi.mock('@/lib/email/templates', () => ({
  sendWorkspaceSuspendedEmail: async () => { h.emails++ },
  sendWorkspaceRestoredEmail: async () => { h.emails++ },
  sendMfaDisabledEmail: async () => ({ ok: true }),
}))
vi.mock('@/lib/auth/security-audit', () => ({ activeWorkspaceIdsForUser: async () => [] }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', () => ({ notifySecurityEvent: async () => {} }))

import { POST as suspendUser } from '@/app/api/admin/users/[id]/suspend/route'
import { POST as restoreUser } from '@/app/api/admin/users/[id]/restore/route'
import { POST as suspendWs } from '@/app/api/admin/workspaces/[id]/suspend/route'
import { POST as restoreWs } from '@/app/api/admin/workspaces/[id]/restore/route'
import { POST as changePlan } from '@/app/api/admin/workspaces/[id]/change-plan/route'
import { POST as extendTrial } from '@/app/api/admin/workspaces/[id]/extend-trial/route'

const body = (b: any = {}) => ({ json: async () => b }) as any
const ERASED_EMAIL = 'deleted-11111111-2222-3333-4444-555555555555@deleted.scopegov.app'

// supabase-js query builders are thenables with NO .catch() — an async fake rpc (a real Promise) hides that, which is
// exactly how the old `.rpc(...).catch(() => {})` shipped. This one is faithful.
function thenableOnly<T>(value: T) {
  return { then: (res: (v: T) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej) }
}

function setup(tables: Record<string, Row[]>, opts: { rpc?: Record<string, (a: any) => any>; revokeError?: boolean; authError?: string } = {}) {
  const db = createFakeSupabase(tables, { rpc: opts.rpc as any })
  h.db = db
  h.service = {
    from: db.client.from,
    rpc: (name: string, args: any) => {
      if (name === 'revoke_user_sessions') {
        db.rpcCalls.push({ name, args })
        return thenableOnly({ data: 2, error: opts.revokeError ? { message: 'boom' } : null })
      }
      return db.client.rpc(name, args)
    },
    auth: { admin: { updateUserById: async () => ({ error: opts.authError ? { message: opts.authError } : null }) } },
  }
}

beforeEach(() => {
  h.audits.length = 0; h.auditResult = true; h.paystackCalls = 0; h.emails = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('B2 — user suspension with a faithful (thenable-only) rpc', () => {
  const user = (over: Row = {}): Row => ({ id: 'u1', email: 'u1@x.com', name: 'U1', is_platform_admin: false, deleted_at: null, suspended_by_admin: false, ...over })

  it('succeeds, marks suspended_by_admin, revokes sessions and writes the audit row', async () => {
    setup({ users: [user()] })
    const res = await suspendUser(body({ reason: 'abuse' }), { params: { id: 'u1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, sessionsRevoked: true, auditLogged: true })
    const row = h.db.tables.users.find((r: any) => r.id === 'u1')
    expect(row.deleted_at).toBeTruthy()
    expect(row.suspended_by_admin).toBe(true)
    expect(h.db.rpcCalls.some((c: any) => c.name === 'revoke_user_sessions')).toBe(true)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({ eventType: 'user.suspended', targetId: 'u1', metadata: { reason: 'abuse', sessionsRevoked: true } })
  })

  it('still suspends (and says so) when the session revoke fails', async () => {
    setup({ users: [user()] }, { revokeError: true })
    const res = await suspendUser(body(), { params: { id: 'u1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, sessionsRevoked: false })
    expect(h.audits[0].metadata.sessionsRevoked).toBe(false)
  })

  it('reports a failed audit write to the caller instead of an unconditional ok', async () => {
    setup({ users: [user()] })
    h.auditResult = false
    const res = await suspendUser(body(), { params: { id: 'u1' } })
    expect(await res.json()).toMatchObject({ ok: true, auditLogged: false })
  })

  it('409s an already-suspended user and refuses admins / self', async () => {
    setup({ users: [user({ deleted_at: '2026-01-01T00:00:00Z' }), user({ id: 'a2', is_platform_admin: true }), user({ id: 'admin1' })] })
    expect((await suspendUser(body(), { params: { id: 'u1' } })).status).toBe(409)
    expect((await suspendUser(body(), { params: { id: 'a2' } })).status).toBe(400)
    expect((await suspendUser(body(), { params: { id: 'admin1' } })).status).toBe(400)
  })
})

describe('B3 / G4 — user restore', () => {
  it('refuses an erased account — nothing is left to restore', async () => {
    setup({ users: [{ id: 'u1', email: ERASED_EMAIL, deleted_at: '2026-01-01T00:00:00Z', suspended_by_admin: false }] })
    const res = await restoreUser(body(), { params: { id: 'u1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('erased')
    expect(h.audits).toHaveLength(0)
  })

  it('will not undo a self-deletion without explicit confirmation', async () => {
    setup({ users: [{ id: 'u1', email: 'u1@x.com', deleted_at: '2026-01-01T00:00:00Z', suspended_by_admin: false }] })
    const res = await restoreUser(body(), { params: { id: 'u1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('self_deleted')
    expect(h.db.tables.users[0].deleted_at).toBeTruthy()
  })

  it('restores a self-deleted account once confirmed, and records that it was one', async () => {
    setup({ users: [{ id: 'u1', email: 'u1@x.com', deleted_at: '2026-01-01T00:00:00Z', suspended_by_admin: false }] })
    const res = await restoreUser(body({ confirmSelfDeleted: true }), { params: { id: 'u1' } })
    expect(res.status).toBe(200)
    expect(h.db.tables.users[0].deleted_at).toBeNull()
    expect(h.audits[0].metadata).toMatchObject({ restoredSelfDeleted: true })
  })

  it('restores an admin suspension on a plain call and clears the flags', async () => {
    setup({ users: [{ id: 'u1', email: 'u1@x.com', deleted_at: '2026-01-01T00:00:00Z', suspended_by_admin: true, suspended_by_admin_at: '2026-01-01T00:00:00Z' }] })
    const res = await restoreUser(body(), { params: { id: 'u1' } })
    expect(res.status).toBe(200)
    expect(h.db.tables.users[0]).toMatchObject({ deleted_at: null, suspended_by_admin: false, suspended_by_admin_at: null })
    expect(h.audits[0].metadata).toEqual({})
  })
})

describe('B11 / G4 — workspace suspend & restore', () => {
  const ws = (over: Row = {}): Row => ({ id: 'w1', name: 'W1', agency_name: 'Agency', deleted_at: null, suspended_by_admin: false, ...over })

  it('answers 409 and does NOT run Paystack / e-mails when the RPC reports it lost the race', async () => {
    setup({ workspaces: [ws()], workspace_members: [], billing: [] },
      { rpc: { admin_suspend_workspace: () => ({ error: { message: 'workspace_not_found_or_already_suspended' } }) } })
    const res = await suspendWs(body(), { params: { id: 'w1' } })
    expect(res.status).toBe(409)
    expect(h.paystackCalls).toBe(0)
    expect(h.emails).toBe(0)
    expect(h.audits).toHaveLength(0)
  })

  it('still 500s on a genuine RPC failure', async () => {
    setup({ workspaces: [ws()], workspace_members: [], billing: [] },
      { rpc: { admin_suspend_workspace: () => ({ error: { message: 'connection reset' } }) } })
    expect((await suspendWs(body(), { params: { id: 'w1' } })).status).toBe(500)
  })

  it('restore 409s on a concurrent-restore race before touching Paystack', async () => {
    setup({ workspaces: [ws({ deleted_at: '2026-01-01T00:00:00Z', suspended_by_admin: true })], billing: [], workspace_members: [] },
      { rpc: { admin_restore_workspace: () => ({ error: { message: 'workspace_not_found_or_not_suspended' } }) } })
    const res = await restoreWs(body(), { params: { id: 'w1' } })
    expect(res.status).toBe(409)
    expect(h.paystackCalls).toBe(0)
  })

  it('will not undo an owner deletion without confirmation, and does once confirmed', async () => {
    const mk = () => setup({ workspaces: [ws({ deleted_at: '2026-01-01T00:00:00Z', suspended_by_admin: false })], billing: [], workspace_members: [] },
      { rpc: { admin_restore_workspace: () => ({ data: null, error: null }) } })
    mk()
    const refused = await restoreWs(body(), { params: { id: 'w1' } })
    expect(refused.status).toBe(409)
    expect((await refused.json()).code).toBe('self_deleted')
    expect(h.db.rpcCalls.some((c: any) => c.name === 'admin_restore_workspace')).toBe(false)

    mk()
    const ok = await restoreWs(body({ confirmSelfDeleted: true }), { params: { id: 'w1' } })
    expect(ok.status).toBe(200)
    expect(h.audits[0].metadata).toMatchObject({ restoredSelfDeleted: true })
  })

  it('reports a failed Paystack cancel to the admin', async () => {
    setup({ workspaces: [ws()], workspace_members: [], billing: [] },
      { rpc: { admin_suspend_workspace: () => ({ data: null, error: null }) } })
    const res = await suspendWs(body({ reason: 'fraud' }), { params: { id: 'w1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, auditLogged: true })
    expect(h.audits[0].metadata.reason).toBe('fraud')
  })
})

describe('B10 — change-plan / extend-trial', () => {
  it('refuses both on a suspended or deleted workspace', async () => {
    setup({ workspaces: [{ id: 'w1', name: 'W', agency_name: 'A', plan_tier: 'trial', trial_ends_at: null, deleted_at: '2026-01-01T00:00:00Z' }], billing: [] })
    expect((await changePlan(body({ plan: 'pro' }), { params: { id: 'w1' } })).status).toBe(409)
    expect((await extendTrial(body({ days: 7 }), { params: { id: 'w1' } })).status).toBe(409)
    expect(h.db.tables.workspaces[0].plan_tier).toBe('trial')
  })

  it('clears an open grace period so payment-overdue cannot revert a comped plan', async () => {
    setup({
      workspaces: [{ id: 'w1', name: 'W', agency_name: 'A', plan_tier: 'solo', trial_ends_at: null, deleted_at: null }],
      billing: [{ workspace_id: 'w1', grace_period_started_at: '2026-09-01T00:00:00Z' }],
    })
    const res = await changePlan(body({ plan: 'pro', reason: 'comp' }), { params: { id: 'w1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, plan: 'pro', graceCleared: true })
    expect(h.db.tables.billing[0].grace_period_started_at).toBeNull()
    expect(h.db.tables.workspaces[0].plan_tier).toBe('pro')
    expect(h.audits[0].metadata).toMatchObject({ previousPlan: 'solo', newPlan: 'pro', graceCleared: true })
  })

  it('extends an active trial', async () => {
    const end = new Date(Date.now() + 3 * 86400_000).toISOString()
    setup({ workspaces: [{ id: 'w1', name: 'W', agency_name: 'A', plan_tier: 'trial', trial_ends_at: end, deleted_at: null }], billing: [] })
    const res = await extendTrial(body({ days: 7 }), { params: { id: 'w1' } })
    expect(res.status).toBe(200)
    const after = new Date(h.db.tables.workspaces[0].trial_ends_at).getTime()
    expect(after - new Date(end).getTime()).toBe(7 * 86400_000)
  })
})

// ── Pure helpers ────────────────────────────────────────────────
import { fmtUtc, summarizeAdminMetadata, ADMIN_EVENT_TYPES } from '@/lib/admin/format'
import { shapeFinance, estimateMrr, fmtMonth, fmtMoney, currentMonthKey } from '@/lib/admin/finance'
import { LIST_PRICES_USD, monthlyListPriceUsd } from '@/lib/billing/list-prices'
import { isAnonymizedEmail, anonymizedEmail } from '@/lib/utils/account-erasure'

describe('format helpers', () => {
  it('fmtUtc renders UTC and tolerates junk', () => {
    expect(fmtUtc('2026-10-03T05:41:28Z')).toBe('2026-10-03 05:41 UTC')
    expect(fmtUtc(null)).toBe('—')
    expect(fmtUtc('not a date')).toBe('—')
  })
  it('summarizes the metadata that used to be invisible (G1)', () => {
    expect(summarizeAdminMetadata('workspace.plan_changed', { previousPlan: 'solo', newPlan: 'pro', reason: 'comp', graceCleared: true }))
      .toBe('solo → pro · payment grace cleared · reason: comp')
    expect(summarizeAdminMetadata('workspace.suspended', { paystackCancelOk: false, membersNotified: 3 })).toContain('Paystack cancel FAILED')
    expect(summarizeAdminMetadata('user.mfa_reset', { factorsRemoved: 1, emailSent: false })).toContain('e-mail NOT sent')
    expect(summarizeAdminMetadata('user.viewed', {})).toBe('')
  })
  it('every event type the routes emit is filterable on the audit page', () => {
    for (const t of ['user.suspended', 'user.restored', 'user.mfa_reset', 'user.sessions_revoked', 'workspace.suspended', 'workspace.restored', 'workspace.plan_changed', 'workspace.trial_extended'])
      expect(ADMIN_EVENT_TYPES).toContain(t)
  })
})

describe('isAnonymizedEmail', () => {
  it('matches exactly what anonymizedEmail produces', () => {
    expect(isAnonymizedEmail(anonymizedEmail('11111111-2222-3333-4444-555555555555'))).toBe(true)
    expect(isAnonymizedEmail('deleted-alice@deleted.scopegov.app')).toBe(false)
    expect(isAnonymizedEmail('alice@example.com')).toBe(false)
    expect(isAnonymizedEmail(null)).toBe(false)
  })
})

describe('finance (G5)', () => {
  it('keeps currencies apart and buckets by month and kind', () => {
    const f = shapeFinance([
      { month: '2026-10-01', currency: 'USD', kind: 'payment', n: 3, total: '297.00' },
      { month: '2026-10-01', currency: 'KES', kind: 'payment', n: 1, total: 5000 },
      { month: '2026-10-01', currency: 'USD', kind: 'refund', n: 1, total: 99 },
      { month: '2026-09-01', currency: 'USD', kind: 'failed', n: 2, total: 0 },
      { month: '2026-09-01', currency: 'USD', kind: 'bogus', n: 9, total: 9 },
    ])
    expect(Object.keys(f).sort()).toEqual(['KES', 'USD'])
    expect(f.USD['2026-10-01'].payment).toEqual({ n: 3, total: 297 })
    expect(f.USD['2026-10-01'].refund.total).toBe(99)
    expect(f.USD['2026-09-01'].failed.n).toBe(2)
    expect(f.KES['2026-10-01'].payment.total).toBe(5000)
  })
  it('estimates MRR at list price: annual/12, ignores trials and subscription-less rows, flags risk and churn', () => {
    const e = estimateMrr([
      { plan_tier: 'pro', plan_interval: 'monthly', paystack_subscription_code: 'S1', cancels_at_period_end: false, grace_period_started_at: null },
      { plan_tier: 'agency', plan_interval: 'annual', paystack_subscription_code: 'S2', cancels_at_period_end: true, grace_period_started_at: null },
      { plan_tier: 'solo', plan_interval: null, paystack_subscription_code: 'S3', cancels_at_period_end: false, grace_period_started_at: '2026-10-01T00:00:00Z' },
      { plan_tier: 'pro', plan_interval: 'monthly', paystack_subscription_code: null, cancels_at_period_end: false, grace_period_started_at: null },
      { plan_tier: 'trial', plan_interval: 'monthly', paystack_subscription_code: 'S4', cancels_at_period_end: false, grace_period_started_at: null },
    ])
    expect(e.subscriptions).toBe(3)
    expect(e.mrrUsd).toBeCloseTo(249 + 3990 / 12 + 39, 5)
    expect(e.cancellingCount).toBe(1); expect(e.cancellingUsd).toBeCloseTo(3990 / 12, 5)
    expect(e.atRiskCount).toBe(1); expect(e.atRiskUsd).toBe(39)
    expect(e.assumedMonthly).toBe(1)
  })
  it('formats months and money without throwing on odd currencies', () => {
    expect(fmtMonth('2026-10-01')).toBe('Oct 2026')
    expect(fmtMoney(1234.5, 'USD')).toBe('$1,234.50')
    expect(fmtMoney(5, 'ZZZ9')).toBe('ZZZ9 5.00')
    expect(fmtMoney(5, '?')).toBe('5.00')
    expect(currentMonthKey(new Date('2026-10-03T00:00:00Z'))).toBe('2026-10-01')
  })
  it('list prices match the plan cards customers see (SettingsClient) — they must not drift', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'components/settings/SettingsClient.tsx'), 'utf8')
    const money = (n: number) => `$${n.toLocaleString('en-US')}`
    for (const [plan, p] of Object.entries(LIST_PRICES_USD)) {
      expect(src).toContain(`${money(p.monthly)}/mo`)
      expect(src).toContain(`${money(p.annual)}/yr`)
      expect(monthlyListPriceUsd(plan, 'monthly')).toBe(p.monthly)
    }
    expect(monthlyListPriceUsd('trial', 'monthly')).toBeNull()
  })
})

// ── Structural guards ───────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out); else out.push(p)
  }
  return out
}
const ROOT = process.cwd()

describe('B1 — every admin Server Component guards itself', () => {
  const pages = walk(path.join(ROOT, 'app/(admin)/admin')).filter(f => /page\.tsx$/.test(f))
  it('finds the admin pages', () => { expect(pages.length).toBeGreaterThanOrEqual(9) })
  for (const file of pages) {
    const src = fs.readFileSync(file, 'utf8')
    if (/^['"]use client['"]/.test(src.trimStart())) continue
    it(`${path.relative(ROOT, file)} calls requireAdminPage() before creating a service client`, () => {
      const guard = src.indexOf('requireAdminPage()')
      const client = src.indexOf('createServiceClient()')
      expect(guard).toBeGreaterThan(-1)
      expect(client === -1 || guard < client).toBe(true)
    })
  }
  it('the page guard redirects a non-admin and returns the actor for an admin', async () => {
    vi.resetModules()
    const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`) })
    vi.doMock('next/navigation', () => ({ redirect }))
    let actor: any = null, needs: any = null
    vi.doMock('@/lib/auth/admin', () => ({ getAdminActor: async () => actor, adminNeedsMfaEnrolment: async () => needs }))
    const { requireAdminPage } = await import('@/lib/admin/page-guard')
    await expect(requireAdminPage()).rejects.toThrow('REDIRECT:/dashboard')
    needs = { name: 'A' }
    await expect(requireAdminPage()).rejects.toThrow('REDIRECT:/mfa-setup?next=%2Fadmin')
    actor = { id: 'a', email: 'a@b.c', name: 'A' }
    await expect(requireAdminPage()).resolves.toBe(actor)
    vi.doUnmock('next/navigation'); vi.doUnmock('@/lib/auth/admin')
  })
})

describe('B8 / B9 / B3 — query hygiene', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  it('no admin API route uses select(\'*\') (secrets would ride along)', () => {
    for (const f of walk(path.join(ROOT, 'app/api/admin')).filter(f => f.endsWith('.ts'))) {
      const src = fs.readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      // the suspend route's server-side-only billing read is allowed: it never reaches the response
      if (f.includes(path.join('workspaces', '[id]', 'suspend')) || f.includes(path.join('workspaces', '[id]', 'restore'))) continue
      expect(src, path.relative(ROOT, f)).not.toMatch(/select\('\*'\)/)
    }
  })
  it('the workspace detail response never carries Paystack e-mail tokens', () => {
    // Comments explain WHY these columns are absent, so only the code is checked.
    const src = read('app/api/admin/workspaces/[id]/route.ts').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(src).not.toMatch(/email_token/)
    expect(src).not.toMatch(/customer_code/)
  })
  it('the overview counts plans in SQL, not by pulling every workspace row', () => {
    const src = read('app/(admin)/admin/page.tsx')
    expect(src).toContain("rpc('admin_workspace_plan_counts')")
    expect(src).not.toMatch(/select\('plan_tier'\)/)
  })
  it('invite-cleanup never erases an admin-suspended user', () => {
    expect(read('app/api/cron/invite-cleanup/route.ts')).toContain(".neq('suspended_by_admin', true)")
  })
  it('migration 141 defines everything the code relies on', () => {
    const sql = read('supabase/migrations/141_admin_panel_hardening.sql')
    for (const needle of ['suspended_by_admin', 'suspended_by_admin_at', 'admin_workspace_plan_counts', 'admin_finance_summary', 'audit_log_billing_event_created'])
      expect(sql).toContain(needle)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_finance_summary\(int\)\s+TO service_role/)
  })
})
