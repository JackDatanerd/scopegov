import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, invoiceEmails: [] as any[], docEmails: [] as any[], alerts: [] as any[], sendOk: true }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async (...a: any[]) => { h.alerts.push(a) } }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async () => {} }))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ id: `a${h.db.tables.audit_log.length}`, created_at: new Date().toISOString(), ...row }); return true },
}))
vi.mock('@/lib/email/reply-to', () => ({ resolveReplyTo: async () => null }))
vi.mock('@/lib/utils/client-contacts', () => ({ withPrimaryContactCc: async () => [] }))
vi.mock('@/lib/documents/renew-invoice-token', () => ({ renewInvoiceTokenIfExpired: async () => ({ renewed: false }) }))
vi.mock('@/lib/email/templates', () => ({
  sendInvoiceReminderEmail: async (p: any) => { h.invoiceEmails.push(p); return h.sendOk ? { ok: true } : { ok: false, error: 'rejected' } },
  sendClientDocumentReminderEmail: async (p: any) => { h.docEmails.push(p); return { ok: true } },
}))

import { POST } from '@/app/api/cron/client-reminders/route'

const DAY = 86_400_000
const dayStr = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
const ws = { id: 'w1', agency_name: 'Studio', brand_colour: '#123', client_reminder_after_days: 3, client_reminder_max: 3, auto_client_reminders: true, deleted_at: null }
const invoice = (over: Row = {}) => ({
  id: 'i1', title: 'Deposit', status: 'sent', token: 'tok', expires_at: null, due_date: dayStr(2), amount: 1500, amount_paid: 0, currency: 'USD',
  invoice_number: 'INV-7', payment_instructions: null, disputed_at: null, dispute_resolved_at: null, payment_claimed_at: null, payment_claim_cleared_at: null,
  workspace_id: 'w1', project_id: 'p1', projects: { id: 'p1', name: 'Acme site', client_id: 'c1', deleted_at: null, clients: { name: 'Acme', email: 'pay@acme.test', cc_emails: [] } }, ...over,
})
const seed = (invoices: Row[], audit: Row[] = []) => createFakeSupabase({ workspaces: [ws], sow_documents: [], change_orders: [], invoices, audit_log: audit })
const run = async () => { const res = await POST({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => { h.invoiceEmails.length = 0; h.docEmails.length = 0; h.alerts.length = 0; h.sendOk = true; vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('client-reminders — "coming due" heads-up', () => {
  it('sends ONE friendly heads-up for an unpaid invoice due within 3 days, and never a second', async () => {
    h.db = seed([invoice()])
    const { body } = await run()
    expect(body.invoiceDueSoonRemindersSent).toBe(1)
    expect(h.invoiceEmails).toHaveLength(1)
    expect(h.invoiceEmails[0]).toMatchObject({ dueSoon: true, isOverdue: false, balanceDue: 1500, to: 'pay@acme.test' })
    expect(h.db.tables.audit_log[0]).toMatchObject({ event_type: 'reminder.sent', entity_id: 'i1', metadata: expect.objectContaining({ automatic: true, due_soon: true }) })
    await run()
    expect(h.invoiceEmails).toHaveLength(1)
  })

  it('does nothing for an invoice not yet within the window, or already paid down to nothing', async () => {
    h.db = seed([invoice({ due_date: dayStr(10) }), invoice({ id: 'i2', amount_paid: 1500, status: 'partially_paid' })])
    await run()
    expect(h.invoiceEmails).toHaveLength(0)
  })

  it('a due-soon heads-up does NOT use up the overdue nag budget or delay it', async () => {
    // due 4 days ago, a heads-up was sent before the due date — the first overdue reminder is still due now, as reminder #1
    h.db = seed([invoice({ status: 'overdue', due_date: dayStr(-4) })], [
      { id: 'a0', workspace_id: 'w1', entity_type: 'invoice', entity_id: 'i1', event_type: 'reminder.sent', created_at: new Date(Date.now() - 7 * DAY).toISOString(), metadata: { automatic: true, due_soon: true } },
    ])
    await run()
    expect(h.invoiceEmails).toHaveLength(1)
    expect(h.invoiceEmails[0]).toMatchObject({ isOverdue: true, dueSoon: false })
    expect(h.db.tables.audit_log.at(-1).metadata).toMatchObject({ reminder_number: 1 })
  })

  it('skips an invoice the client has an open dispute or an open "I\'ve paid" claim on — and resumes once the claim is cleared', async () => {
    h.db = seed([
      invoice({ id: 'd', disputed_at: new Date().toISOString() }),
      invoice({ id: 'c', payment_claimed_at: new Date().toISOString() }),
    ])
    await run()
    expect(h.invoiceEmails).toHaveLength(0)

    h.db = seed([invoice({ id: 'c', payment_claimed_at: '2026-01-01T00:00:00.000Z', payment_claim_cleared_at: '2026-01-02T00:00:00.000Z' })])
    await run()
    expect(h.invoiceEmails).toHaveLength(1)
  })

  it('an overdue invoice with an open payment claim is not nagged', async () => {
    h.db = seed([invoice({ status: 'overdue', due_date: dayStr(-9), payment_claimed_at: new Date().toISOString() })])
    await run()
    expect(h.invoiceEmails).toHaveLength(0)
  })

  it('a heads-up whose email was rejected is recorded as failed and retried on the next run', async () => {
    h.db = seed([invoice()]); h.sendOk = false
    const first = await run()
    expect(first.body.rowErrors?.join(' ')).toMatch(/rejected/)
    expect(h.db.tables.audit_log.map((a: Row) => a.event_type)).toEqual(['reminder.sent', 'reminder.failed'])
    h.sendOk = true
    await run()
    expect(h.invoiceEmails).toHaveLength(2)
    expect(h.db.tables.audit_log.filter((a: Row) => a.event_type === 'reminder.sent')).toHaveLength(2)
  })

  it("is off unless the workspace opted in to automatic reminders", async () => {
    h.db = createFakeSupabase({ workspaces: [{ ...ws, auto_client_reminders: false }], invoices: [invoice()], audit_log: [] })
    await run()
    expect(h.invoiceEmails).toHaveLength(0)
  })
})
