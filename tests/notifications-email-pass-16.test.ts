import { describe, it, expect } from 'vitest'
import { sendCoAcceptedEmail, sendCoAcceptedClientEmail, sendSowEmail } from '@/lib/email/templates'
import { __setResendForTests } from '@/lib/email/send'

const sent: any[] = []
__setResendForTests({ emails: { send: async (b: any) => { sent.push(b); return { data: { id: 'x' }, error: null } } } } as any)
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('pass 16: retainer renewal wording', () => {
  it('client confirmation states the new monthly rate, never "additional"', async () => {
    sent.length = 0
    await sendCoAcceptedClientEmail({ to: 'a@b.co', clientName: 'C', agencyName: 'A', projectName: 'P', coTitle: 'Renewal', total: 4000, currency: 'USD', portalUrl: 'https://p', isRenewal: true, previousRate: 3000, renewalTermMonths: 1 })
    const t = text(sent[0].html)
    expect(t).not.toMatch(/additional/i)
    expect(t).toContain('USD 4,000.00 / month')
    expect(t).toContain('previously USD 3,000.00 / month')
    expect(t).toContain('1 month')
    expect(t).not.toContain('1 months')
  })
  it('agency email and subject do not claim added value', async () => {
    sent.length = 0
    await sendCoAcceptedEmail({ to: ['a@b.co'], clientName: 'C', projectName: 'P', coTitle: 'Renewal', total: 4000, currency: 'USD', acceptedBy: 'x', projectUrl: 'u', isRenewal: true, previousRate: 3000, renewalTermMonths: 6 })
    expect(sent[0].subject).not.toContain('+USD')
    const t = text(sent[0].html)
    expect(t).not.toMatch(/Additional value/)
    expect(t).toContain('New monthly retainer rate')
    expect(t).toContain('6 months')
  })
  it('ordinary CO wording is unchanged', async () => {
    sent.length = 0
    await sendCoAcceptedClientEmail({ to: 'a@b.co', clientName: 'C', agencyName: 'A', projectName: 'P', coTitle: 'T', total: 500, currency: 'USD', portalUrl: 'u' })
    expect(text(sent[0].html)).toContain('for an additional USD 500.00')
  })
  it('SOW retainer email says "1 month"', async () => {
    sent.length = 0
    await sendSowEmail({ to: 'a@b.co', clientName: 'C', agencyName: 'A', projectName: 'P', contractValue: 1000, currency: 'USD', isRetainer: true, retainerMonths: 1, portalUrl: 'u', expiresAt: '2026-12-01T00:00:00Z' })
    expect(text(sent[0].html)).toContain('1 month (')
    expect(text(sent[0].html)).not.toContain('1 months')
  })
})
