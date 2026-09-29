import { describe, it, expect, vi } from 'vitest'

const sent: any[] = []
vi.mock('@/lib/email/send', () => ({
  sendEmail: async (payload: any) => { sent.push(payload); return { ok: true, id: 'x' } },
}))

import { sendInvoicePaymentClaimedEmail } from '@/lib/email/templates'

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
