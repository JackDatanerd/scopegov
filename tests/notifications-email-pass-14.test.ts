import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { cleanSubject, sendEmail, __setResendForTests } from '@/lib/email/send'
import { sendSowExpiredEmail, sendInvoiceSentInternalEmail, sendGuardianFlagStalledEmail } from '@/lib/email/templates'

afterEach(() => __setResendForTests(null))

describe('email subjects are single-line (pass 14, B2)', () => {
  it('replaces CR/LF, control and line-separator characters and collapses whitespace', () => {
    expect(cleanSubject('Invoice 1: Phase\r\nBcc: x@y.com   — Proj')).toBe('Invoice 1: Phase Bcc: x@y.com — Proj')
    expect(cleanSubject('a\u2028b\u0000c\u0085d')).toBe('a b c d')
  })
  it('never sends an empty subject', () => {
    expect(cleanSubject('  \n ')).toBe('Notification from ScopeGov')
    expect(cleanSubject(undefined)).toBe('Notification from ScopeGov')
  })
  it('sendEmail hands the provider the cleaned subject', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'e1' }, error: null })
    __setResendForTests({ emails: { send } } as any)
    const r = await sendEmail({ from: 'a <a@b.co>', to: 'c@d.co', subject: 'Hi\nthere', html: '<p>x</p>' })
    expect(r.ok).toBe(true)
    expect(send.mock.calls[0][0].subject).toBe('Hi there')
  })
})

describe('empty-recipient senders return a SendResult (pass 14, B4)', () => {
  it('resolves { ok, skipped } instead of undefined', async () => {
    const a = await sendSowExpiredEmail({ to: [], clientName: 'C', projectName: 'P', projectUrl: 'u' })
    const b = await sendInvoiceSentInternalEmail({ to: [], clientName: 'C', projectName: 'P', amount: 1, currency: 'USD', projectUrl: 'u' })
    const c = await sendGuardianFlagStalledEmail({ to: [], projectName: 'P', clientName: 'C', severity: 'low', description: 'd', daysOpen: 3, projectUrl: 'u' })
    for (const r of [a, b, c]) expect(r).toEqual({ ok: true, id: null, skipped: true })
  })
})

describe('bell and email recipient caps agree (pass 14, B1)', () => {
  it('no finance email fan-out is capped below the 25-recipient bell cap', () => {
    for (const f of ['app/api/invoices/[id]/payments/route.ts', 'app/api/cron/retainer-milestones/route.ts', 'app/api/cron/payment-overdue/route.ts', 'lib/documents/send-invoice.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toMatch(/getMemberEmailsWithPermission\([^)]*'VIEW_FINANCIALS', 10,/)
    }
  })
})
