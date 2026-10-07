import { describe, it, expect } from 'vitest'
import { opsAlertRecipients } from '@/lib/utils/ops-recipients'

describe('opsAlertRecipients', () => {
  it('returns [] when unset or blank', () => {
    expect(opsAlertRecipients(undefined)).toEqual([])
    expect(opsAlertRecipients('')).toEqual([])
    expect(opsAlertRecipients('  , ; ')).toEqual([])
  })
  it('keeps a single address', () => {
    expect(opsAlertRecipients('ops@x.test')).toEqual(['ops@x.test'])
  })
  it('splits comma / semicolon / whitespace lists and de-duplicates', () => {
    expect(opsAlertRecipients('a@x.test, b@x.test;c@x.test  a@x.test')).toEqual(['a@x.test', 'b@x.test', 'c@x.test'])
  })
})

describe('sendEmail accepts the parsed list (B2 regression)', () => {
  it('a comma-separated string is rejected, the parsed array is sent', async () => {
    const { sendEmail, __setResendForTests } = await import('@/lib/email/send')
    const sent: any[] = []
    __setResendForTests({ emails: { send: async (b: any) => { sent.push(b); return { data: { id: 'x' }, error: null } } } } as any)
    const raw = await sendEmail({ from: 'x@y.com', to: 'a@x.test,b@x.test', subject: 's', html: '<p>h</p>' } as any)
    expect(raw.ok).toBe(false)
    const parsed = await sendEmail({ from: 'x@y.com', to: opsAlertRecipients('a@x.test,b@x.test'), subject: 's', html: '<p>h</p>' } as any)
    expect(parsed.ok).toBe(true)
    expect(sent).toHaveLength(1)
  })
})
