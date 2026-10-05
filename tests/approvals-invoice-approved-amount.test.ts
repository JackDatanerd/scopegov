import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Approvals (section 11), approved-amount re-check on the invoice auto-send.
// sendCoDocument already refused to auto-send a CO that changed size after approval was requested; sendInvoiceDocument had no
// equivalent, and PATCH /api/invoices/[id] reads the approval lock and then writes through update_invoice_capped (which guards
// only on status='draft'), so an edit landing in that gap could be auto-sent, numbered and emailed at an unapproved amount.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('auto-send refuses an invoice that changed size after approval was requested', () => {
  function fakeService(invoice: any) {
    const chain: any = {
      select: () => chain, eq: () => chain, neq: () => chain, not: () => chain, limit: () => chain,
      single: async () => ({ data: invoice, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
    }
    return { from: () => chain, rpc: async () => ({ data: null, error: { message: 'rpc must not be reached' } }) }
  }
  const invoice = (amount: number | string, extra: any = {}) => ({
    id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'T', amount, currency: 'USD', status: 'draft',
    due_date: '2999-01-01', payment_instructions: 'Pay by bank transfer', invoice_number: null, po_number: null,
    milestone_id: null, project_id: 'p1', subtotal: amount, tax_rate: 0, tax_inclusive: false, line_items: [],
    sow_id: null, co_id: null, ...extra,
    projects: { id: 'p1', name: 'P', client_id: 'cl1', deleted_at: null,
      clients: { name: 'C', email: 'c@x.co', cc_emails: [] }, workspaces: { id: 'w1', agency_name: 'Ag' } },
    sow_documents: null, change_orders: null,
  })
  const params = { invoiceId: 'aaaaaaaa-0000-4000-8000-000000000001', workspaceId: 'w1', actorId: 'u1', actorEmail: 'a@x.co', actorName: 'A' }

  it('refuses with a clear 409 when the amount no longer matches what was approved, before any number is consumed', async () => {
    const { sendInvoiceDocument } = await import('@/lib/documents/send-invoice')
    const r = await sendInvoiceDocument(fakeService(invoice(50000)), { ...params, approvedGateAmount: 5000 })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(409); expect(r.error).toMatch(/edited after it was submitted for approval/) }
  })

  it('compares numeric strings and ignores sub-cent rounding', async () => {
    const { sendInvoiceDocument } = await import('@/lib/documents/send-invoice')
    // Matching amounts get past the guard and stop at the NEXT check (the fake has no workspace signing secret) — not at the guard.
    for (const [amount, approved] of [['5000.00', 5000], [5000.004, 5000], [5000, '5000']] as const) {
      const r = await sendInvoiceDocument(fakeService(invoice(amount)), { ...params, approvedGateAmount: approved as any })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).not.toMatch(/edited after/)
    }
  })

  it('a direct send (no approved amount) is unaffected', async () => {
    const { sendInvoiceDocument } = await import('@/lib/documents/send-invoice')
    for (const p of [params, { ...params, approvedGateAmount: null }]) {
      const r = await sendInvoiceDocument(fakeService(invoice(50000)), p)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).not.toMatch(/edited after/)
    }
  })

  it('the approval engine hands the approved amount to the invoice send, as it does for the CO send', () => {
    const src = read('lib/approvals/engine.ts')
    expect(src).toMatch(/sendInvoiceDocument\(service, \{[^}]*approvedGateAmount: request\.context\?\.amount/)
    expect(src).toMatch(/sendCoDocument\(service, \{[^}]*approvedGateAmount: request\.context\?\.amount/)
  })
})
