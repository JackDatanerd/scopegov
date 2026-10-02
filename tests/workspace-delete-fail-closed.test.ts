import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

// Workspace lifecycle re-audit (independent pass, round 22).
//
// B2  workspace/delete wrote its `workspace.deleted` audit entry only AFTER a sequential, awaited per-member email
//     loop, on a route with no maxDuration. A timeout after the RPC committed left a deleted workspace with no audit
//     record. The audit is now written immediately after the commit; emails run inside a time budget; maxDuration is set.
// B3  Every read that gates the delete ignored its `error`: owner lookup, owner-membership lookup, the seven
//     live-document guards and — worst — the billing read. A failed billing read made `billing` null, and
//     cancelPaystackSubscription(null) answers "nothing to cancel", so the delete went through with the customer's
//     Paystack subscription still charging a deleted workspace. All of them now fail closed (500, nothing changed).

const h = vi.hoisted(() => ({
  client: null as any,
  cancel: vi.fn(),
  resume: vi.fn(),
  alertOps: vi.fn(),
  audit: vi.fn(),
  email: vi.fn(),
  session: null as any,
  order: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.client }))
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session, hasPermission: () => true }))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: (...a: any[]) => h.cancel(...a),
  resumePaystackSubscription: (...a: any[]) => h.resume(...a),
  // Inconclusive by default (Paystack unreachable), so a failed cancel keeps its 502 path in these tests.
  fetchPaystackSubscription: async () => ({ ok: false, notFound: false, error: 'unreachable' }),
}))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: (...a: any[]) => h.alertOps(...a) }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: (...a: any[]) => h.audit(...a) }))
vi.mock('@/lib/email/templates', () => ({ sendWorkspaceDeletedEmail: (...a: any[]) => h.email(...a) }))

const WS = 'w1'
const delReq = () => new Request('http://localhost/api/workspace/delete', {
  method: 'DELETE', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirmName: 'Acme', workspaceId: WS }),
})

function setup(opts: { errors?: any[]; extraMembers?: number; billing?: boolean } = {}) {
  const members: any[] = [{ id: 'm1', workspace_id: WS, user_id: 'owner', status: 'active', user: { email: 'o@example.com', name: 'Owner' } }]
  for (let i = 0; i < (opts.extraMembers ?? 0); i++) {
    members.push({ id: `mx${i}`, workspace_id: WS, user_id: `u${i}`, status: 'active', user: { email: `u${i}@example.com`, name: `U${i}` } })
  }
  const fake = createFakeSupabase({
    workspaces: [{ id: WS, created_by: 'owner' }],
    billing: opts.billing === false ? [] : [{
      workspace_id: WS, paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok',
      cancels_at_period_end: false, cancelled_by_workspace_delete_at: null,
    }],
    workspace_members: members,
  }, {
    errors: opts.errors,
    rpc: { delete_workspace_atomic: () => ({ error: null }) },
  })
  h.client = fake.client
  return fake
}

beforeEach(() => {
  h.order.length = 0
  h.cancel.mockReset(); h.resume.mockReset(); h.alertOps.mockReset(); h.audit.mockReset(); h.email.mockReset()
  h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: false })
  h.alertOps.mockResolvedValue(undefined)
  h.audit.mockImplementation(async () => { h.order.push('audit'); return true })
  h.email.mockImplementation(async () => { h.order.push('email'); return {} })
  h.session = { id: 'owner', email: 'o@example.com', name: 'Owner', workspaceId: WS, workspaceName: 'Acme', agencyName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
})
afterEach(() => { vi.restoreAllMocks() })

describe('B3: delete fails closed when a gating read fails — nothing is cancelled or deleted', () => {
  const nothingHappened = (fake: ReturnType<typeof createFakeSupabase>) => {
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
    expect(fake.rpcCalls.filter(c => c.name === 'delete_workspace_atomic')).toHaveLength(0)
    expect(fake.tables.billing?.[0]?.cancelled_by_workspace_delete_at ?? null).toBeNull()
  }

  it('baseline: with no errors the delete succeeds and cancels the subscription', async () => {
    const fake = setup()
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(fake.rpcCalls.filter(c => c.name === 'delete_workspace_atomic')).toHaveLength(1)
  })

  it('billing read failure: 500, Paystack never cancelled (was: delete went ahead, subscription kept charging)', async () => {
    const fake = setup({ errors: [{ table: 'billing', op: 'select', message: 'statement timeout' }] })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/Nothing was changed/)
    nothingHappened(fake)
  })

  it('owner lookup failure: 500 (was: owner check silently skipped)', async () => {
    const fake = setup({ errors: [{ table: 'workspaces', op: 'select', message: 'boom' }] })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(500)
    nothingHappened(fake)
  })

  it('owner-membership lookup failure for a NON-owner admin: 500 (was: treated as "owner is gone" and allowed)', async () => {
    h.session = { ...h.session, id: 'admin2' }
    const fake = setup({ errors: [{ table: 'workspace_members', op: 'select', message: 'boom' }] })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(500)
    nothingHappened(fake)
  })

  it.each(['sow_documents', 'change_orders', 'invoice_payments', 'invoices'])(
    'live-document guard read failure on %s: 500, nothing cancelled',
    async (table) => {
      const fake = setup({ errors: [{ table, op: 'select', message: 'boom' }] })
      const { DELETE } = await import('@/app/api/workspace/delete/route')
      const res = await DELETE(delReq())
      expect(res.status).toBe(500)
      nothingHappened(fake)
    },
  )

  it('a real block still answers 409, not 500 (the guards still work when the read succeeds)', async () => {
    const fake = createFakeSupabase({
      workspaces: [{ id: WS, created_by: 'owner' }],
      sow_documents: [{ id: 's1', workspace_id: WS, status: 'signed' }],
      workspace_members: [{ id: 'm1', workspace_id: WS, user_id: 'owner', status: 'active' }],
    })
    h.client = fake.client
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(409)
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it('a workspace with no billing row at all (read OK, zero rows) still deletes — only a read ERROR is blocked', async () => {
    setup({ billing: false })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
  })
})

describe('B2: audit is recorded right after the commit; emails are budgeted', () => {
  it('writes the audit entry BEFORE any member email', async () => {
    setup({ extraMembers: 2 })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(h.order[0]).toBe('audit')
    expect(h.order.filter(x => x === 'email')).toHaveLength(2)
    expect(h.audit.mock.calls[0][1].eventType).toBe('workspace.deleted')
    expect(h.audit.mock.calls[0][1].metadata.billing_cancelled).toBe(true)
  })

  it('audit is still written when every email fails or throws', async () => {
    setup({ extraMembers: 2 })
    h.email.mockRejectedValue(new Error('provider down'))
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(h.audit).toHaveBeenCalledTimes(1)
  })

  it('stops emailing once the time budget is spent, and still returns success', async () => {
    setup({ extraMembers: 4 })
    let clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    h.email.mockImplementation(async () => { h.order.push('email'); clock += 30_000; return {} })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    // t=0 send (→30s), t=30s send (→60s), t=60s > 40s budget → remaining skipped
    expect(h.email).toHaveBeenCalledTimes(2)
    expect(h.audit).toHaveBeenCalledTimes(1)
  })

  it('declares an explicit maxDuration', async () => {
    const mod: any = await import('@/app/api/workspace/delete/route')
    expect(mod.maxDuration).toBe(60)
  })
})
