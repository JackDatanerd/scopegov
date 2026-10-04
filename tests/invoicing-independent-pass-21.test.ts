import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'

const sent: any[] = []
vi.mock('@/lib/email/send', () => ({
  sendEmail: async (payload: any) => { sent.push(payload); return { ok: true, id: 'x' } },
}))

import { sendInvoiceReminderEmail } from '@/lib/email/templates'

const common = {
  to: 'c@client.test', clientName: 'Acme', agencyName: 'Agency', projectName: 'Site',
  invoiceNumber: 'INV-1', title: 'Milestone 1', currency: 'USD', portalUrl: 'https://p.test/x',
  balanceDue: 100, dueDate: '2026-11-30',
}
const render = async (extra: Record<string, unknown>) => {
  sent.length = 0
  await sendInvoiceReminderEmail({ ...common, ...extra } as any)
  return sent[0] as { html: string; subject: string }
}

describe('invoice reminder wording for a due date that has not arrived', () => {
  it('manual reminder on a not-yet-due invoice says "It is due on", not "Due date was"', async () => {
    const m = await render({ dueInFuture: true })
    expect(m.html).toContain('It is due on 30 November 2026')
    expect(m.html).not.toContain('Due date was')
    expect(m.html).toContain('is\n        outstanding')
    expect(m.subject).toMatch(/^Reminder:/)
  })
  it('past-due (not yet flipped to overdue) keeps "Due date was"', async () => {
    const m = await render({})
    expect(m.html).toContain('Due date was 30 November 2026')
  })
  it('overdue and the cron due-soon wording are unchanged', async () => {
    expect((await render({ isOverdue: true })).html).toContain('Due date was')
    const soon = await render({ dueSoon: true })
    expect(soon.html).toContain('It is due on')
    expect(soon.subject).toMatch(/^Due soon:/)
  })
})

describe('remind route passes the flag on the client calendar', () => {
  const src = readFileSync('app/api/invoices/[id]/remind/route.ts', 'utf8')
  it('selects both time zones and computes dueInFuture', () => {
    expect(src).toMatch(/payment_terms_note, timezone\)/)
    expect(src).toMatch(/brand_colour, timezone\)/)
    expect(src).toMatch(/dueInFuture = invoice\.status !== 'overdue'/)
    expect(src).toMatch(/dueInFuture,\n/)
  })
})
