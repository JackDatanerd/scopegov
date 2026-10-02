import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

// Workspace lifecycle independent pass 6.
//
// B1  workspace/delete decided "did THIS delete cancel the Paystack subscription?" from the result of
//     the one cancel call the winning request made. When an earlier attempt (timed out before the RPC
//     committed) or an overlapping request had already disabled it, Paystack answered "already
//     non-renewing", no marker was written, and a later restore never re-enabled billing. The marker is
//     now written BEFORE the Paystack call.
// B2  workspace/leave deletes the leaver's pending invites (leave_workspace_atomic) without telling
//     anyone; DELETE /api/team/[id] reports the count for the same action. It is now counted (with the
//     RPC's NULL-safe `IS DISTINCT FROM` predicate) and surfaced.

const h = vi.hoisted(() => ({
  client: null as any,
  getUserId: 'u1',
  cancel: vi.fn(),
  resume: vi.fn(),
  alertOps: vi.fn(),
  audit: vi.fn(),
  notify: vi.fn(),
  session: null as any,
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.client,
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: h.getUserId, email: 'dana@example.com', user_metadata: { name: 'Meta Dana' } } } }) },
  }),
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => h.session,
  hasPermission: () => true,
}))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/integrations/paystack', () => ({
  cancelPaystackSubscription: (...a: any[]) => h.cancel(...a),
  resumePaystackSubscription: (...a: any[]) => h.resume(...a),
  // Inconclusive by default (Paystack unreachable), so a failed cancel keeps its 502 path in these tests.
  fetchPaystackSubscription: async () => ({ ok: false, notFound: false, error: 'unreachable' }),
}))
vi.mock('@/lib/billing/ops-alert', () => ({ alertBillingOps: (...a: any[]) => h.alertOps(...a) }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: (...a: any[]) => h.audit(...a) }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: (...a: any[]) => h.notify(...a) }))
vi.mock('@/lib/email/templates', async () => {
  const actual: any = await vi.importActual('@/lib/email/templates')
  return Object.fromEntries(Object.keys(actual).map(k => [k, async () => ({})]))
})

// ───────────────────────────── B1: workspace/delete ─────────────────────────────

const WS = 'w1'
const delReq = () => new Request('http://localhost/api/workspace/delete', {
  method: 'DELETE', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirmName: 'Acme', workspaceId: WS }),
})

function setupDelete(billing: Record<string, any> | null, rpcResult: { message: string } | null = null, extra: Parameters<typeof createFakeSupabase>[1] = {}) {
  const fake = createFakeSupabase({
    workspaces: [{ id: WS, created_by: 'owner' }],
    billing: billing ? [{ workspace_id: WS, paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok', cancels_at_period_end: false, cancelled_by_workspace_delete_at: null, ...billing }] : [],
    workspace_members: [{ id: 'm1', workspace_id: WS, user_id: 'owner', status: 'active', user: { email: 'o@example.com', name: 'Owner' } }],
  }, {
    rpc: { delete_workspace_atomic: () => ({ error: rpcResult }) },
    ...extra,
  })
  h.client = fake.client
  return fake
}
const billingRow = (fake: ReturnType<typeof createFakeSupabase>) => fake.tables.billing[0]

beforeEach(() => {
  h.cancel.mockReset(); h.resume.mockReset(); h.alertOps.mockReset(); h.audit.mockReset(); h.notify.mockReset()
  h.alertOps.mockResolvedValue(undefined); h.audit.mockResolvedValue(true)
  h.resume.mockResolvedValue({ ok: true })
  h.session = { id: 'owner', email: 'o@example.com', name: 'Owner', workspaceId: WS, workspaceName: 'Acme', agencyName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
})

describe('B1: delete records that it owns the cancellation BEFORE calling Paystack', () => {
  it('a normal delete stamps the marker first, and it is still there afterwards', async () => {
    const fake = setupDelete({})
    let markerAtCancelTime: unknown = 'not-called'
    h.cancel.mockImplementation(async () => { markerAtCancelTime = billingRow(fake).cancelled_by_workspace_delete_at; return { ok: true, alreadyCancelled: false } })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(markerAtCancelTime).toBeTruthy()                          // written before the Paystack call
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeTruthy()
    expect(h.audit.mock.calls[0][1].metadata.billing_cancelled).toBe(true)
  })

  it('RETRY after an attempt that disabled the subscription but never committed: marker survives "already cancelled"', async () => {
    // Attempt 1 stamped the marker and disabled Paystack, then timed out; the webhook flipped the flag.
    const fake = setupDelete({ cancels_at_period_end: true, cancelled_by_workspace_delete_at: '2026-10-01T10:00:00.000Z' })
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: true })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeTruthy()   // restore will resume it
    expect(h.audit.mock.calls[0][1].metadata.billing_cancelled).toBe(true)
  })

  it('OVERLAPPING delete that lost the stamp race keeps the marker even though Paystack says "already cancelled"', async () => {
    // The route reads billing (no marker), then ANOTHER request stamps + disables before our conditional
    // stamp lands. Ours must match zero rows, and we must still treat the cancellation as the delete's.
    const fake = setupDelete({})
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: true })
    const realFrom = fake.client.from
    let raced = false
    fake.client.from = (t: string) => {
      const b = realFrom(t)
      if (t === 'billing') {
        const realUpdate = b.update
        b.update = (p: any) => {
          if (!raced && p?.cancelled_by_workspace_delete_at) {
            raced = true
            billingRow(fake).cancelled_by_workspace_delete_at = '2026-10-02T00:00:00.000Z'   // the other request's stamp
            billingRow(fake).cancels_at_period_end = true                                    // ...and the webhook after its disable
          }
          return realUpdate(p)
        }
      }
      return b
    }
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(raced).toBe(true)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeTruthy()
    expect(h.audit.mock.calls[0][1].metadata.billing_cancelled).toBe(true)
  })

  it('owner had ALREADY cancelled their plan: delete owns nothing, writes no marker (restore must not undo that)', async () => {
    const fake = setupDelete({ cancels_at_period_end: true })
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: true })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeNull()
    expect(h.audit.mock.calls[0][1].metadata.billing_cancelled).toBe(false)
    // and no marker was ever written, not even transiently
    expect(fake.calls.filter(c => c.table === 'billing' && c.op === 'update' && c.payload?.cancelled_by_workspace_delete_at).length).toBe(0)
  })

  it('subscription already ended upstream (nothing to cancel): the marker stamped for the call is withdrawn', async () => {
    const fake = setupDelete({})
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: true })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeNull()
    expect(h.audit.mock.calls[0][1].metadata.billing_cancelled).toBe(false)
  })

  it('no subscription at all: billing is never touched', async () => {
    const fake = setupDelete({ paystack_subscription_code: null })
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: true })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    expect((await DELETE(delReq())).status).toBe(200)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeNull()
  })

  it('Paystack refuses: 502, delete RPC never runs, and the marker this request wrote is removed', async () => {
    const fake = setupDelete({}, null, {})
    h.cancel.mockResolvedValue({ ok: false, alreadyCancelled: false, error: 'Paystack down' })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(502)
    expect(fake.rpcCalls.length).toBe(0)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeNull()
  })

  it('cannot record the marker: refuses (500) BEFORE touching Paystack', async () => {
    const fake = setupDelete({}, null, {
      errors: [{ table: 'billing', op: 'update', message: 'write failed', when: p => !!p?.cancelled_by_workspace_delete_at }],
    })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(500)
    expect(h.cancel).not.toHaveBeenCalled()
    expect(fake.rpcCalls.length).toBe(0)
  })

  it('delete RPC fails after a fresh cancel: subscription resumed AND the marker + flag cleared together', async () => {
    const fake = setupDelete({}, { message: 'boom' })
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: false })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(500)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeNull()
    expect(billingRow(fake).cancels_at_period_end).toBe(false)
  })

  it('delete RPC fails on a RETRY (earlier attempt had disabled it): still resumed — previously skipped because alreadyCancelled', async () => {
    const fake = setupDelete({ cancels_at_period_end: true, cancelled_by_workspace_delete_at: '2026-10-01T10:00:00.000Z' }, { message: 'boom' })
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: true })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(500)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeNull()
    expect(billingRow(fake).cancels_at_period_end).toBe(false)
  })

  it('resume fails after a failed delete: marker stays (the subscription really is cancelled) and ops is paged', async () => {
    const fake = setupDelete({}, { message: 'boom' })
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: false })
    h.resume.mockResolvedValue({ ok: false, error: 'nope' })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(500)
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeTruthy()
    expect(h.alertOps).toHaveBeenCalled()
  })

  it('already_deleted from the RPC: nothing is resumed and the winner\'s marker is left alone', async () => {
    const fake = setupDelete({ cancelled_by_workspace_delete_at: '2026-10-01T10:00:00.000Z', cancels_at_period_end: true }, { message: 'already_deleted' })
    h.cancel.mockResolvedValue({ ok: true, alreadyCancelled: true })
    const { DELETE } = await import('@/app/api/workspace/delete/route')
    const res = await DELETE(delReq())
    expect(res.status).toBe(409)
    expect(h.resume).not.toHaveBeenCalled()
    expect(billingRow(fake).cancelled_by_workspace_delete_at).toBeTruthy()
  })
})

// ───────────────────────────── B2: workspace/leave ─────────────────────────────

interface LeaveSetup { inviteCount?: number | null; countError?: boolean; rpcError?: string | null }
function setupLeave({ inviteCount = 0, countError = false, rpcError = null }: LeaveSetup = {}) {
  const log: string[] = []
  const inviteFilters: Array<{ method: string; args: any[] }> = []
  h.getUserId = 'u1'
  h.client = {
    from(table: string) {
      let head = false
      const calls: Array<{ method: string; args: any[] }> = []
      const b: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (res: any, rej: any) => {
              let r: any
              if (table === 'users') r = { data: { deleted_at: null, name: 'Dana' }, error: null }
              else if (table === 'workspace_members' && head) {
                log.push('count-invites')
                calls.forEach(c => inviteFilters.push(c))
                r = countError ? { data: null, count: null, error: { message: 'count failed' } } : { data: null, count: inviteCount, error: null }
              } else if (table === 'workspace_members') r = { data: { id: 'mem-1', workspace_id: 'w1', workspaces: { name: 'Acme' } }, error: null }
              else r = { data: null, error: null }
              return Promise.resolve(r).then(res, rej)
            }
          }
          return (...args: any[]) => {
            if (prop === 'select' && args[1]?.head) head = true
            calls.push({ method: prop, args })
            return b
          }
        },
      })
      return b
    },
    rpc: async () => { log.push('rpc'); return { error: rpcError ? { message: rpcError } : null } },
  }
  return { log, inviteFilters }
}
const leaveReq = () => new Request('http://localhost/api/workspace/leave', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'w1' }),
}) as any

describe('B2: leaving reports the pending invites it revoked', () => {
  it('counts BEFORE the RPC deletes them, with the RPC\'s NULL-safe predicate (not a plain <>)', async () => {
    const { log, inviteFilters } = setupLeave({ inviteCount: 2 })
    const { POST } = await import('@/app/api/workspace/leave/route')
    const res = await POST(leaveReq())
    expect(res.status).toBe(200)
    expect(log).toEqual(['count-invites', 'rpc'])
    const methods = inviteFilters.map(c => c.method)
    expect(methods).toContain('or')
    expect(methods).not.toContain('neq')                                   // `<>` would drop the NULL user_id invites
    expect(inviteFilters.find(c => c.method === 'or')!.args[0]).toBe('user_id.is.null,user_id.neq.u1')
    expect(inviteFilters.find(c => c.method === 'in')!.args).toEqual(['status', ['invited', 'expired']])
    expect(inviteFilters.find(c => c.method === 'eq' && c.args[0] === 'invited_by')!.args[1]).toBe('u1')
  })

  it('tells the remaining admins how many were revoked, records it in the audit entry, and returns it', async () => {
    setupLeave({ inviteCount: 2 })
    const { POST } = await import('@/app/api/workspace/leave/route')
    const res = await POST(leaveReq())
    const json = await res.json()
    expect(json).toEqual({ ok: true, revokedPendingInvites: 2 })
    expect(h.notify.mock.calls[0][1].body).toBe('Dana left the workspace. 2 pending invites they sent were revoked with them — re-send them from your own account if still needed.')
    expect(h.audit.mock.calls[0][1].metadata).toEqual({ revoked_pending_invites: 2 })
  })

  it('uses the singular for one invite', async () => {
    setupLeave({ inviteCount: 1 })
    const { POST } = await import('@/app/api/workspace/leave/route')
    await POST(leaveReq())
    expect(h.notify.mock.calls[0][1].body).toContain('1 pending invite they sent was revoked with them — re-send it from your own account')
  })

  it('says nothing extra (and adds no response field) when there were none', async () => {
    setupLeave({ inviteCount: 0 })
    const { POST } = await import('@/app/api/workspace/leave/route')
    const res = await POST(leaveReq())
    expect(await res.json()).toEqual({ ok: true })
    expect(h.notify.mock.calls[0][1].body).toBe('Dana left the workspace.')
    expect(h.audit.mock.calls[0][1].metadata).toEqual({})
  })

  it('a failed count never blocks leaving', async () => {
    setupLeave({ countError: true })
    const { POST } = await import('@/app/api/workspace/leave/route')
    const res = await POST(leaveReq())
    expect(res.status).toBe(200)
    expect(h.notify.mock.calls[0][1].body).toBe('Dana left the workspace.')
  })

  it('a refused leave notifies nobody (guards unchanged)', async () => {
    setupLeave({ inviteCount: 3, rpcError: 'last_member' })
    const { POST } = await import('@/app/api/workspace/leave/route')
    const res = await POST(leaveReq())
    expect(res.status).toBe(400)
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })
})
