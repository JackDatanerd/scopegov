import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('section 12 independent pass', () => {
  it('migration 114 tests the paid-regression branch before the forward "sent" branch', () => {
    const sql = read('supabase/migrations/114_milestone_paid_regression_order.sql')
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('$$;'))
    const regression = fn.indexOf("OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid'")
    const sent = fn.indexOf("NEW.status = 'sent'")
    expect(regression).toBeGreaterThan(-1)
    expect(sent).toBeGreaterThan(-1)
    expect(regression).toBeLessThan(sent)
    // regression is the opening IF (no ELSIF before it), so paid -> sent can't be swallowed by the sent branch
    expect(fn.slice(0, regression)).not.toContain('ELSIF')
    expect(fn.slice(0, regression)).toContain('IF OLD IS NOT NULL AND')
  })

  it('project page computes the Billing-tab position live instead of reading the oldest 90 snapshots', () => {
    const src = read('app/(app)/projects/[id]/page.tsx')
    expect(src).toContain('computeContractPosition(service, id)')
    expect(src).not.toContain('.limit(90)')
    expect(src).not.toContain("from('contract_reconciliation_snapshots')")
  })

  it('registry portfolio strip is computed live over paginated live projects, not from snapshot rows', () => {
    const src = read('app/(app)/invoices/page.tsx')
    expect(src).toContain('computeContractPositions(service, liveProjects)')
    expect(src).not.toContain("from('contract_reconciliation_snapshots')")
    expect(src).toContain("neq('status', 'Archived')")
  })

  it('BillingTab links the PDF for void invoices too', () => {
    const src = read('components/invoices/BillingTab.tsx')
    expect(src).toContain("(inv.status === 'paid' || inv.status === 'void')")
  })
})
