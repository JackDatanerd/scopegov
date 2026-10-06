import { describe, it, expect, vi } from 'vitest'

const inserted: any[] = []
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ insert: async (row: any) => { inserted.push(row); return { error: null } } }) }),
}))
import { sendCoEmail } from '@/lib/email/templates'
import { sendEmail, __setResendForTests } from '@/lib/email/send'

const LONE_HIGH_AT_END = /[\uD800-\uDBFF]$/

describe('email_log truncation never leaves half an emoji (pass 12)', () => {
  it('subject cut at 300 lands inside an emoji', async () => {
    inserted.length = 0
    __setResendForTests({ emails: { send: async () => ({ data: { id: 'x' }, error: null }) } } as any)
    await sendCoEmail({
      to: 'client@example.com', clientName: 'C', agencyName: 'A',
      projectName: 'y'.repeat(82) + '😀' + 'z'.repeat(60), coTitle: 'x'.repeat(200),
      total: 10, currency: 'USD', portalUrl: 'https://p.test/x', log: { workspaceId: 'w', kind: 'co.send' },
    } as any)
    const s: string = inserted[0].subject
    expect(LONE_HIGH_AT_END.test(s)).toBe(false)
    expect(s.length).toBeLessThanOrEqual(300)
  })

  it('provider error cut at 500 lands inside an emoji', async () => {
    inserted.length = 0
    __setResendForTests({ emails: { send: async () => ({ data: null, error: { message: 'e'.repeat(499) + '😀tail' } }) } } as any)
    const r = await sendEmail({ from: '"A" <a@b.co>', to: 'c@d.co', subject: 's', html: '<p/>' }, { workspaceId: 'w', kind: 'invoice.send' })
    expect(r.ok).toBe(false)
    expect(LONE_HIGH_AT_END.test(inserted[0].error)).toBe(false)
  })

  it('short subjects are stored unchanged', async () => {
    inserted.length = 0
    __setResendForTests({ emails: { send: async () => ({ data: { id: 'x' }, error: null }) } } as any)
    await sendEmail({ from: '"A" <a@b.co>', to: 'c@d.co', subject: 'Hello 😀', html: '<p/>' }, { workspaceId: 'w', kind: 'sow.send' })
    expect(inserted[0].subject).toBe('Hello 😀')
  })
})
