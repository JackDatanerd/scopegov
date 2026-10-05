import { describe, it, expect, vi } from 'vitest'
import { __setResendForTests, sendEmail } from '@/lib/email/send'
import { timeAgo } from '@/lib/utils/notification-links'

function mockResend() {
  const send = vi.fn(async () => ({ data: { id: 'em_1' }, error: null }))
  __setResendForTests({ emails: { send } } as any)
  return send
}

describe('sendEmail strict address filtering', () => {
  it('drops malformed CCs that the loose pattern accepts, instead of sinking the message', async () => {
    const send = mockResend()
    const r = await sendEmail({ from: 'x <a@b.co>', to: 'client@acme.com', cc: ['a@b..co', 'a..b@c.co', 'ok@acme.com'], subject: 's', html: 'h' })
    expect(r.ok).toBe(true)
    expect((send.mock.calls[0] as any)[0].cc).toEqual(['ok@acme.com'])
  })
  it('a malformed primary address is a clear failure, not a provider 422', async () => {
    const send = mockResend()
    const r = await sendEmail({ from: 'x <a@b.co>', to: 'a@b..co', subject: 's', html: 'h' })
    expect(r.ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('timeAgo year', () => {
  const now = Date.parse('2026-10-05T12:00:00Z')
  it('shows the year for a date in a previous year', () => {
    expect(timeAgo('2025-12-01T00:00:00Z', now)).toContain('2025')
  })
  it('omits the year within the current year', () => {
    expect(timeAgo('2026-09-20T12:00:00Z', now)).not.toContain('2026')
  })
})
