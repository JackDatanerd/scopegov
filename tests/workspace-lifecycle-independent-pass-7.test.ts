import { describe, it, expect, vi, beforeEach } from 'vitest'

// Workspace lifecycle independent pass — B1: POST /api/workspace/transfer-ownership resolved its target
// workspace from the session's CURRENT active workspace only, so a stale Settings tab (another tab had
// switched workspaces) could hand ownership of a different workspace to the person picked for the one it
// was showing. It now needs the client's workspaceId to match (409 otherwise, like DELETE /workspace/delete),
// and a non-UUID newOwnerUserId is a 400 instead of a Postgres 22P02 -> 500.

const h = vi.hoisted(() => ({ rpc: vi.fn() }))

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
    rpc: async (...a: any[]) => { h.rpc(...a); return { error: null } },
  }),
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'owner', email: 'o@example.com', name: 'Owner', workspaceId: 'w-active', workspaceName: 'Acme' }),
}))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', () => ({ notifyUsers: async () => undefined }))
vi.mock('@/lib/email/templates', () => ({ sendOwnershipTransferredEmail: async () => ({}) }))
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async (fn: () => Promise<unknown>) => fn() }))

const UID = '22222222-2222-4222-8222-222222222222'
const post = (body: unknown) => new Request('http://localhost/api/workspace/transfer-ownership', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => h.rpc.mockReset())

describe('POST /api/workspace/transfer-ownership — workspace staleness guard', () => {
  it('a workspaceId that is not the active workspace is refused with 409 and nothing is transferred', async () => {
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    const res = await POST(post({ newOwnerUserId: UID, workspaceId: 'w-other' }))
    expect(res.status).toBe(409)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('a missing workspaceId is refused the same way', async () => {
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    const res = await POST(post({ newOwnerUserId: UID }))
    expect(res.status).toBe(409)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('a non-UUID newOwnerUserId is a 400, not a 500', async () => {
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    const res = await POST(post({ newOwnerUserId: 'abc', workspaceId: 'w-active' }))
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('the matching workspace goes through to the RPC for that workspace', async () => {
    const { POST } = await import('@/app/api/workspace/transfer-ownership/route')
    const res = await POST(post({ newOwnerUserId: UID, workspaceId: 'w-active' }))
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('transfer_workspace_ownership', {
      p_workspace_id: 'w-active', p_current_owner_id: 'owner', p_new_owner_id: UID,
    })
  })
})
