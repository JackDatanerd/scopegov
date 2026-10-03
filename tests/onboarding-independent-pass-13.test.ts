import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// Onboarding independent pass 13: POST /api/workspace/create awaited the welcome email with no
// time limit, so a stalled mail provider held the wizard's first step after the workspace was
// already created. The email is best-effort and must not block the response.

function builder(result: any) {
  const b: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: any, rej: any) => Promise.resolve(result).then(res, rej)
      return (..._a: any[]) => b
    },
  })
  return b
}

let emailImpl: () => Promise<any> = async () => ({})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => builder({ data: { deleted_at: null, name: 'Jack' }, error: null }),
    rpc: async () => ({ error: null }),
  }),
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'jack@example.com' } } }) },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))
vi.mock('@/lib/email/templates', () => ({ sendWorkspaceCreatedEmail: () => emailImpl() }))

const req = () => new NextRequest('http://localhost/api/workspace/create', {
  method: 'POST',
  body: JSON.stringify({ agencyName: 'Acme Agency', industry: 'Web & App Development' }),
  headers: { 'content-type': 'application/json' },
})

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('POST /api/workspace/create — welcome email is not on the critical path', () => {
  it('answers 200 with the new workspace even when the email provider never responds', async () => {
    emailImpl = () => new Promise(() => {})
    const { POST } = await import('@/app/api/workspace/create/route')
    const pending = POST(req())
    await vi.advanceTimersByTimeAsync(4100)
    const res = await pending
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.workspaceId).toBeTruthy()
    expect(json.activeSet).toBe(true)
  })

  it('still succeeds when the email rejects', async () => {
    emailImpl = async () => { throw new Error('provider down') }
    const { POST } = await import('@/app/api/workspace/create/route')
    const res = await POST(req())
    expect(res.status).toBe(200)
  })
})
