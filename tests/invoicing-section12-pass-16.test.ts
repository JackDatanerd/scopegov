import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('section 12 independent pass 16', () => {
  it('migration 136: the payment guard reads the invoice status under its existing row lock and refuses draft/void inserts', () => {
    const sql = read('supabase/migrations/136_invoice_payment_guard_rejects_void_and_draft.sql')
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'))
    // status is selected by the same FOR UPDATE statement that already took the lock
    expect(fn).toMatch(/SELECT amount, status INTO v_invoice_amount, v_invoice_status\s+FROM public\.invoices WHERE id = v_invoice_id FOR UPDATE/)
    expect(fn).toContain("v_invoice_status IN ('draft', 'void')")
    expect(fn).toContain("TG_OP = 'INSERT'")
    // OLD is only read on UPDATE (never on INSERT), and DELETE stays exempt
    const oldIdx = fn.indexOf('OLD.amount')
    expect(oldIdx).toBeGreaterThan(fn.indexOf("ELSIF TG_OP = 'UPDATE'"))
    expect(fn).not.toMatch(/TG_OP = 'DELETE'/)
    // the original overpayment rule is still there, unchanged
    expect(fn).toContain('v_total_after > v_invoice_amount + 0.005')
    expect(fn).toContain('Payment would exceed invoice balance')
  })

  it('payment POST and PATCH routes turn the guard error into a 409, not a 500', () => {
    for (const p of ['app/api/invoices/[id]/payments/route.ts', 'app/api/invoices/[id]/payments/[paymentId]/route.ts']) {
      const src = read(p)
      const i = src.indexOf("includes('draft or void invoice')")
      expect(i, p).toBeGreaterThan(-1)
      expect(src.slice(i, i + 400), p).toContain('status: 409')
    }
  })

  it('registry page does not present a failed list or ledger read as an empty / zero ledger', () => {
    const src = read('app/(app)/invoices/page.tsx')
    expect(src).toContain('(invErr || ledgerFailed) &&')
    expect(src).toContain('ledgerFailed = true')
    // the "No invoices yet" empty state is not rendered for a query that errored
    expect(src).toContain('invErr && !safeInvoices.length ? null')
    // Collected shows a dash instead of 0.00 when the ledger could not be read
    expect(src).toMatch(/ledgerFailed \? \(\s*<div className="mc-val green">—<\/div>/)
  })
})
