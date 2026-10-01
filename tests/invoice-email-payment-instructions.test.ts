import { describe, it, expect } from 'vitest'

const sent: any[] = []
import { vi } from 'vitest'
vi.mock('@/lib/email/send', () => ({
  sendEmail: async (payload: any) => { sent.push(payload); return { ok: true, id: 'x' } },
}))

import { sendInvoiceEmail, sendInvoiceReminderEmail } from '@/lib/email/templates'

const common = {
  to: 'c@client.test', clientName: 'Acme', agencyName: 'Agency', projectName: 'Site',
  invoiceNumber: 'INV-1', title: 'Milestone 1', currency: 'USD', portalUrl: 'https://p.test/x',
}
const send = (paymentInstructions: string | null) =>
  sendInvoiceEmail({ ...common, amount: 100, paymentInstructions })
const remind = (paymentInstructions: string | null) =>
  sendInvoiceReminderEmail({ ...common, balanceDue: 100, paymentInstructions })

describe('invoice emails render rich-text payment instructions as HTML', () => {
  for (const [name, fn] of [['invoice email', send], ['reminder email', remind]] as const) {
    it(`${name}: stored TipTap HTML is rendered, not printed as markup`, async () => {
      sent.length = 0
      await fn('<p>Bank: Equity &amp; Co</p><ul><li>Acct 123</li></ul>')
      const html: string = sent[0].html
      expect(html).toContain('<p>Bank: Equity &amp; Co</p>')
      expect(html).toContain('<li>Acct 123</li>')
      expect(html).not.toContain('&lt;p&gt;')
      expect(html).not.toContain('&amp;amp;')
    })
    it(`${name}: scripts and unsafe links are stripped`, async () => {
      sent.length = 0
      await fn('<p>Pay <a href="javascript:alert(1)">here</a></p><script>alert(1)</script>')
      expect(sent[0].html).not.toContain('javascript:')
      expect(sent[0].html).not.toContain('<script>alert')
    })
    it(`${name}: legacy plain-text rows keep their line breaks and are escaped`, async () => {
      sent.length = 0
      await fn('Bank: A & B\nAcct 123 <x>')
      const html: string = sent[0].html
      expect(html).toContain('Bank: A &amp; B<br>Acct 123 &lt;x&gt;')
    })
    it(`${name}: an empty editor (<p></p>) or null renders no empty box`, async () => {
      sent.length = 0
      await fn('<p></p>')
      await fn(null)
      expect(sent[0].html).not.toContain('Payment instructions')
      expect(sent[1].html).not.toContain('Payment instructions')
    })
  }
})
