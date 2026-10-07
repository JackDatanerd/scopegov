import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/security-audit', () => ({ logSecurityAudit: vi.fn(async () => {}) }))
vi.mock('@/lib/utils/notify', () => ({ notifySecurityEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/email/templates', () => ({ sendNewSignInEmail: vi.fn(async () => ({ ok: true })) }))

import { registerSessionSeen } from '@/lib/auth/session-seen'

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = (sid: string) => `${b64({ alg: 'HS256' })}.${b64({ session_id: sid, iat: Math.floor(Date.now() / 1000) })}.sig`

function harness(selectResult: { data: any; error: any }) {
  const calls = { select: 0, insert: 0 }
  const service = {
    from: () => ({
      select: () => { calls.select++; const q: any = { eq: () => q, gte: () => q, limit: async () => selectResult }; return q },
      insert: async () => { calls.insert++; return { error: null } },
    }),
  }
  const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: token('sid-read-failure') } } }) } }
  const args = {
    service, supabase, user: { id: 'u1', email: 'a@x.test' }, name: 'A', workspaceId: 'w1',
    headers: { get: (h: string) => (h === 'user-agent' ? 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537' : null) },
  }
  return { calls, args }
}

describe('registerSessionSeen — failed read of existing sessions (B1)', () => {
  it('does not register the device as known when the read fails, and retries on the next request', async () => {
    const h = harness({ data: null, error: { message: 'connection reset' } })
    await registerSessionSeen(h.args as any)
    expect(h.calls.insert).toBe(0)
    await registerSessionSeen(h.args as any)
    expect(h.calls.select).toBe(2) // not short-circuited by the in-memory marker
    expect(h.calls.insert).toBe(0)
  })
})
