import { describe, it, expect, vi, beforeEach } from 'vitest'

// Workspace lifecycle re-audit (round 22) — B1 (cross-section: transfer-ownership).
//
// transfer_workspace_ownership reassigns workspaces.created_by. When the workspace is a trial and the recipient
// already owns their own active trial, that UPDATE trips one_active_trial_per_creator (23505). The route had no
// mapping for it, so the owner got "Could not transfer ownership. Try again." — a 500 that can never succeed on
// retry. Reproduced against Postgres 16 with the real partial index and the real function from migration 052.
// It is now a 409 that says what to do.

const h = vi.hoisted(() => ({
  rpcError: null as any,
  rpc: vi.fn(),
  audit: vi.fn(),
  notify: vi.fn(),
  email: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const b: any = new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === 'then') return (res: any) => Promise.resolve({ data: { name: 'New Owner', email: 'new@example.com' }, error: null }).then(res)
          return () => b
        },
      })
      return b
    },
    rpc: async (...a: any[]) => { h.rpc(...a); return { error: h.rpcError } },
  }),
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'owner', email: 'o@example.com', name: 'Owner', workspaceId: 'w1', workspaceName: 'Acme' }),
}))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: (...a: any[]) => h.audit(...a) }))
vi.mock('@/lib/utils/notify', () => ({ notifyUsers: (...a: any[]) => h.notify(...a) }))
vi.mock('@/lib/email/templates', () => ({ sendOwnershipTransferredEmail: (...a: any[]) => h.email(...a) }))
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async (fn: () => Promise<unknown>) => fn() }))

const post = () => new Request('http://localhost/api/workspace/transfer-ownership', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newOwnerUserId: 'u2' }),
})

beforeEach(() => {
  h.rpcError = null
  h.rpc.mockReset(); h.audit.mockReset(); h.notify.mockReset(); h.email.mockReset()
  h.audit.mockResolvedValue(true); h.notify.mockResolvedValue(undefined); h.email.mockResolvedValue({})
})

describe('POST /api/workspace/transfer-ownership — trial-index collision', () => {
  it('recipient already owns an active trial: 409 with an actionable message, no audit/notify/email', async () => {
    h.rpcError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "one_active_trial_per_creator"',
    }
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    const res = await POST(post())
    expect(res.status).toBe(409)
    const { error } = await res.json()
    expect(error).toMatch(/already owns an active trial/)
    expect(error).toMatch(/upgrade/i)
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.email).not.toHaveBeenCalled()
  })

  it('a different unique violation is NOT mislabelled as the trial problem (stays a 500)', async () => {
    h.rpcError = { code: '23505', message: 'duplicate key value violates unique constraint "some_other_index"' }
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    const res = await POST(post())
    expect(res.status).toBe(500)
  })

  it('an unrelated failure that merely mentions the index name without 23505 stays a 500', async () => {
    h.rpcError = { code: 'XX000', message: 'something about one_active_trial_per_creator' }
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    const res = await POST(post())
    expect(res.status).toBe(500)
  })

  it('existing mappings are unchanged', async () => {
    h.rpcError = { message: 'target_lacks_permission' }
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    expect((await POST(post())).status).toBe(400)
    h.rpcError = { message: 'not_owner' }
    expect((await POST(post())).status).toBe(403)
  })

  it('success path still audits, notifies and returns ok', async () => {
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(h.audit).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
})
