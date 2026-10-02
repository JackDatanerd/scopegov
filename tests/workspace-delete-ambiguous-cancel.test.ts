import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

// Workspace lifecycle independent pass 23 — B1.
//
// workspace/delete treated EVERY failed cancelPaystackSubscription() call as "nothing was disabled": it
// unstamped its marker and answered 502 "try again", leaving a live workspace. But Paystack can accept the
// disable and the response still be lost or time out; its subscription.disable webhook then flips
// cancels_at_period_end on the live workspace and the period-end sweep downgrades a paying customer.
// billing/cancel already asks Paystack for the real state before giving up (Billing pass 10 B2); delete now does too.

const h = vi.hoisted(() => ({
  client: null as any,
  cancel: vi.fn(),
  resume: vi.fn(),
  fetchSub: vi.fn(),
  alertOps: vi.fn(),
  session: null as any,
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.client }))
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session, hasPermission: () => true }))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: (...a: any[]) => h.cancel(...a),
  resumePaystackSubscription: (...a: any[]) => h.resume(...a),
  fetchPaystackSubscription: (...a: any[]) => h.fetchSub(...a),
}))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: (...a: any[]) => h.alertOps(...a) }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: vi.fn(async () => true) }))
vi.mock('@/lib/email/templates', () => ({ sendWorkspaceDeletedEmail: vi.fn(async () => ({})) }))

const WS = 'w1'
const delReq = () => new Request('http://localhost/api/workspace/delete', {
  method: 'DELETE', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirmName: 'Acme', workspaceId: WS }),
})

function setup() {
  const fake = createFakeSupabase({
    workspaces: [{ id: WS, created_by: 'owner' }],
    billing: [{
      workspace_id: WS, paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok',
      cancels_at_period_end: false, cancelled_by_workspace_delete_at: null,
    }],
    workspace_members: [{ id: 'm1', workspace_id: WS, user_id: 'owner', status: 'active', user: { email: 'o@example.com', name: 'Owner' } }],
  }, { rpc: { delete_workspace_atomic: () => ({ error: null }) } })
  h.client = fake.client
  return fake
}
const rpcs = (f: ReturnType<typeof createFakeSupabase>) => f.rpcCalls.filter(c => c.name === 'delete_workspace_atomic')

beforeEach(() => {
  h.cancel.mockReset(); h.resume.mockReset(); h.fetchSub.mockReset(); h.alertOps.mockReset()
  h.alertOps.mockResolvedValue(undefined)
  h.cancel.mockResolvedValue({ ok: false, alreadyCancelled: false, error: 'request timed out' })
  h.session = { id: 'owner', email: 'o@example.com', name: 'Owner', workspaceId: WS, workspaceName: 'Acme', agencyName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
})
afterEach(() => { vi.restoreAllMocks() })

describe('B1: a failed cancel call is checked against Paystack before the delete is refused', () => {
  it.each(['non-renewing', 'cancelled', 'completed', 'complete'])(
    'cancel call failed but Paystack reports %s: the delete proceeds and KEEPS its marker (so restore re-enables it)',
    async (status) => {
      h.fetchSub.mockResolvedValue({ ok: true, sub: { status } })
      const fake = setup()
      const { DELETE } = await import('@/app/api/workspace/delete/route')
      const res = await DELETE(delReq())
      expect(res.status).toBe(200)
      expect(h.fetchSub).toHaveBeenCalledWith('SUB_1')
      expect(rpcs(fake)).toHaveLength(1)
      expect(fake.tables.billing[0].cancelled_by_workspace_delete_at).toBeTruthy()
    },
  )

  it('cancel call failed and Paystack still reports active: 502, marker cleared, nothing deleted (genuine refusal)', async () => {
    h.fetchSub.mockResolvedValue({ ok: true, sub: { status: 'active' } })
    const fake = setup()
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(502)
    expect(rpcs(fake)).toHaveLength(0)
    expect(fake.tables.billing[0].cancelled_by_workspace_delete_at ?? null).toBeNull()
  })

  it('cancel call failed and the status lookup also fails: still 502, marker cleared, nothing deleted', async () => {
    h.fetchSub.mockResolvedValue({ ok: false, notFound: false, error: 'unreachable' })
    const fake = setup()
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(502)
    expect(rpcs(fake)).toHaveLength(0)
    expect(fake.tables.billing[0].cancelled_by_workspace_delete_at ?? null).toBeNull()
  })

  it('a cancel that succeeds never triggers the lookup', async () => {
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: false })
    const fake = setup()
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(h.fetchSub).not.toHaveBeenCalled()
    expect(rpcs(fake)).toHaveLength(1)
  })
})
