import { describe, it, expect, vi } from 'vitest'

const sent: any[] = []
vi.mock('@/lib/email/send', () => ({
  sendEmail: async (payload: any) => { sent.push(payload); return { ok: true, id: 'x' } },
}))

import { sendInvoicePaymentClaimedEmail, sendCoAcceptedEmail, sendCoAcceptedClientEmail } from '@/lib/email/templates'

describe('sendInvoicePaymentClaimedEmail', () => {
  it('formats the balance with the currency\'s own precision and never prints a raw currency string', async () => {
    sent.length = 0
    await sendInvoicePaymentClaimedEmail({
      to: ['a@agency.test'], clientName: 'Acme', projectName: 'Site', invoiceNumber: 'INV-1',
      balanceDue: 1234.5, currency: '<b>x</b>', projectUrl: 'https://app.test/p',
    })
    expect(sent[0].html).not.toContain('<b>x</b>')
    expect(sent[0].html).toContain('USD 1,234.50')
  })
  it('uses zero fraction digits for JPY', async () => {
    sent.length = 0
    await sendInvoicePaymentClaimedEmail({
      to: ['a@agency.test'], clientName: 'Acme', projectName: 'Site', balanceDue: 5000, currency: 'JPY', projectUrl: 'https://app.test/p',
    })
    expect(sent[0].html).toContain('JPY 5,000')
    expect(sent[0].html).not.toContain('5,000.00')
  })
})

describe('credit change order acceptance emails', () => {
  const base = { clientName: 'Acme', projectName: 'Site', coTitle: 'Drop blog', total: -300, currency: 'USD' }
  it('agency email words a credit as a reduction, never "additional value" or "+USD -300"', async () => {
    sent.length = 0
    await sendCoAcceptedEmail({ ...base, to: ['a@agency.test'], acceptedBy: 'Jo', projectUrl: 'https://app.test/p', isCredit: true })
    expect(sent[0].subject).toContain('Credit change order accepted')
    expect(sent[0].subject).toContain('USD 300.00')
    expect(sent[0].subject).not.toContain('-300')
    expect(sent[0].html).toContain('Contract value reduced by')
    expect(sent[0].html).not.toContain('Additional value locked in')
    expect(sent[0].html).not.toContain('-300')
  })
  it('an ordinary CO is unchanged', async () => {
    sent.length = 0
    await sendCoAcceptedEmail({ ...base, total: 300, to: ['a@agency.test'], acceptedBy: 'Jo', projectUrl: 'https://app.test/p' })
    expect(sent[0].subject).toContain('+USD 300.00')
    expect(sent[0].html).toContain('Additional value locked in')
  })
  it('client confirmation says "a credit of", not "an additional -USD"', async () => {
    sent.length = 0
    await sendCoAcceptedClientEmail({ ...base, to: 'c@client.test', agencyName: 'Agency', portalUrl: 'https://p.test/x', isCredit: true })
    expect(sent[0].html).toContain('as a credit of')
    expect(sent[0].html).not.toContain('an additional')
    expect(sent[0].html).not.toContain('-300')
  })
})
