// Notifications & email — independent pass 18.
//   B1  session-seen: only a unique violation means "a concurrent request registered it"; any other insert error
//       must clear the in-memory marker so the next request retries (and can still send the new-device alert).
//   B2  checkedSend: a send skipped for lack of a recipient keeps its `skipped` flag; client-facing callers can refuse it.
//   B3  sendPaymentFailedEmail: the body states days REMAINING, not a "N-day grace period".
//   B4  sendEmail: a provider rate limit is retried; a quota error or other rejection is not.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/security-audit', () => ({ logSecurityAudit: vi.fn(async () => {}) }))
vi.mock('@/lib/utils/notify', () => ({ notifySecurityEvent: vi.fn(async () => {}) }))
const { sendNewSignInEmail } = vi.hoisted(() => ({ sendNewSignInEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/email/templates', async (orig) => ({ ...(await orig<any>()), sendNewSignInEmail }))

import { registerSessionSeen } from '@/lib/auth/session-seen'
import { checkedSend } from '@/lib/email/delivery'
import { sendEmail, __setResendForTests, __setRateLimitRetryDelaysForTests } from '@/lib/email/send'

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = (sid: string) => `${b64({ alg: 'HS256' })}.${b64({ session_id: sid, iat: Math.floor(Date.now() / 1000), auth_time: Math.floor(Date.now() / 1000) })}.sig`

function seenHarness(sid: string, insertErrors: Array<{ code?: string; message: string } | null>) {
  const calls = { select: 0, insert: 0 }
  const prior = [{ session_id: 'other', device_key: 'some-other-device' }]
  const service = {
    from: () => ({
      select: () => { calls.select++; const q: any = { eq: () => q, gte: () => q, limit: async () => ({ data: prior, error: null }) }; return q },
      insert: async () => ({ error: insertErrors[Math.min(calls.insert++, insertErrors.length - 1)] }),
    }),
  }
  const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: token(sid) } } }) } }
  const args = {
    service, supabase, user: { id: 'u1', email: 'a@x.test' }, name: 'A', workspaceId: 'w1',
    headers: { get: (h: string) => (h === 'user-agent' ? 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537' : null) },
  }
  return { calls, args }
}

describe('B1 registerSessionSeen — insert failure', () => {
  it('retries on the next request after a non-duplicate insert error, then sends the alert', async () => {
    sendNewSignInEmail.mockClear()
    const h = seenHarness('sid-b1-retry', [{ code: '08006', message: 'connection reset' }, null])
    await registerSessionSeen(h.args as any)
    expect(sendNewSignInEmail).not.toHaveBeenCalled()
    await registerSessionSeen(h.args as any)
    expect(h.calls.insert).toBe(2) // not short-circuited by the in-memory marker
    expect(sendNewSignInEmail).toHaveBeenCalledTimes(1)
  })

  it('treats a unique violation as a concurrent registration: no retry, no alert', async () => {
    sendNewSignInEmail.mockClear()
    const h = seenHarness('sid-b1-dup', [{ code: '23505', message: 'duplicate key value' }])
    await registerSessionSeen(h.args as any)
    await registerSessionSeen(h.args as any)
    expect(h.calls.insert).toBe(1)
    expect(sendNewSignInEmail).not.toHaveBeenCalled()
  })
})

describe('B2 checkedSend — skipped sends', () => {
  const skipped = async () => ({ ok: true, id: null, skipped: true })
  it('keeps the skipped flag by default (internal fan-outs may legitimately have nobody to tell)', async () => {
    expect(await checkedSend(skipped)).toEqual({ ok: true, skipped: true })
  })
  it('fails a skipped send when a recipient is required (client-facing sends)', async () => {
    const r = await checkedSend(skipped, 'x', { requireRecipient: true })
    expect(r.ok).toBe(false)
  })
  it('a real send is unaffected by requireRecipient', async () => {
    expect(await checkedSend(async () => ({ ok: true, id: 'e1' }), 'x', { requireRecipient: true })).toEqual({ ok: true })
  })
  it('sendEmail to an empty or anonymised-only list is what produces skipped', async () => {
    __setResendForTests({ emails: { send: vi.fn() } } as any)
    for (const to of ['', ['a@deleted.scopegov.app']]) {
      const r = await checkedSend(() => sendEmail({ from: 'a@b.co', to, subject: 's', html: 'h' }), 'x', { requireRecipient: true })
      expect(r.ok).toBe(false)
    }
  })
})

describe('B4 sendEmail — provider rate limit', () => {
  const payload = { from: 'a@b.co', to: 'c@d.co', subject: 's', html: 'h' }
  it('retries a rate_limit_exceeded response and succeeds once the limit clears', async () => {
    __setRateLimitRetryDelaysForTests([1, 1])
    const send = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } })
      .mockResolvedValueOnce({ data: { id: 'e1' }, error: null })
    __setResendForTests({ emails: { send } } as any)
    expect(await sendEmail(payload)).toEqual({ ok: true, id: 'e1' })
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('gives up after the retries and reports the failure', async () => {
    __setRateLimitRetryDelaysForTests([1, 1])
    const send = vi.fn().mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } })
    __setResendForTests({ emails: { send } } as any)
    const r = await sendEmail(payload)
    expect(r.ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('does not retry a quota error or any other rejection', async () => {
    __setRateLimitRetryDelaysForTests([1, 1])
    for (const name of ['daily_quota_exceeded', 'validation_error']) {
      const send = vi.fn().mockResolvedValue({ data: null, error: { name, message: 'nope' } })
      __setResendForTests({ emails: { send } } as any)
      expect((await sendEmail(payload)).ok).toBe(false)
      expect(send).toHaveBeenCalledTimes(1)
    }
  })
})

describe('B3 sendPaymentFailedEmail — wording', () => {
  it('states the days remaining and never presents them as a fresh grace period', async () => {
    const { sendPaymentFailedEmail } = await import('@/lib/email/templates')
    const send = vi.fn().mockResolvedValue({ data: { id: 'e1' }, error: null })
    __setResendForTests({ emails: { send } } as any)
    await sendPaymentFailedEmail({ to: 'o@x.co', name: 'O', agencyName: 'Acme', upgradeUrl: 'https://x/y', graceDaysLeft: 2 })
    await sendPaymentFailedEmail({ to: 'o@x.co', name: 'O', agencyName: 'Acme', upgradeUrl: 'https://x/y', graceDaysLeft: 1 })
    const [two, one] = send.mock.calls.map(c => c[0].html as string)
    expect(two).toContain('<strong>2 days remain</strong>')
    expect(one).toContain('<strong>1 day remains</strong>')
    expect(two + one).not.toMatch(/-day grace period/)
  })
})
