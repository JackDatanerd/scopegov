import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isAdjustmentLine } from '@/lib/utils/rescale-line-items'
import { computeCoTotals } from '@/lib/documents/co-totals'

describe('CO-B: only real system adjustment lines are adjustments', () => {
  it('does not treat a user-typed "Negotiated increase ..." line as an adjustment', () => {
    expect(isAdjustmentLine({ description: 'Negotiated increase in support hours', quantity: 5 })).toBe(false)
    expect(isAdjustmentLine({ description: 'Negotiated total review workshop' })).toBe(false)
    expect(isAdjustmentLine({ description: 'Negotiated discount (per counter-offer)', quantity: 3 })).toBe(false)
  })
  it('still recognises flagged and exact legacy system lines', () => {
    expect(isAdjustmentLine({ kind: 'adjustment', description: 'anything' })).toBe(true)
    expect(isAdjustmentLine({ description: 'Negotiated discount (per counter-offer)', quantity: 1 })).toBe(true)
    expect(isAdjustmentLine({ description: 'Negotiated increase (per counter-offer)' })).toBe(true)
    expect(isAdjustmentLine({ description: 'Negotiated total (per client counter-offer)' })).toBe(true)
  })
  it('a re-save keeps the quantity and price of a line that merely starts with that wording', () => {
    const first = computeCoTotals([{ id: 'L1', description: 'Negotiated increase in support hours', quantity: 5, rate: 100 }], 0, false) as any
    const stored = first.totals.lineItems
    const allowed = new Set<string>(stored.filter((l: any) => isAdjustmentLine(l) && l.id).map((l: any) => l.id))
    const second = computeCoTotals(stored, 0, false, allowed) as any
    expect(second.totals.lineItems[0]).toMatchObject({ quantity: 5, rate: 100, total: 500 })
    expect(second.totals.lineItems[0].kind).toBeUndefined()
    expect(second.totals.total).toBe(500)
  })
})

describe('CO-A: the Impact Analysis sign survives the Courier font', () => {
  const src = readFileSync('lib/pdf/renderer.tsx', 'utf8')
  it('prints an ASCII hyphen, not U+2212, for a negative change', () => {
    expect(src).toContain("delta < 0 ? '-' : '+'")
    expect(src).not.toContain("delta < 0 ? '\u2212'")
  })
})

describe('CO-C: a financials-hidden member can still edit non-money fields', () => {
  const src = readFileSync('components/co/CoEditor.tsx', 'utf8')
  it('does not lock the whole editor or stop autosave on financialsHidden', () => {
    expect(src).not.toMatch(/const isLocked = [^\n]*financialsHidden/)
    expect(src).not.toMatch(/if \(loadFailed \|\| pendingApproval \|\| financialsHidden/)
  })
  it('never sends money fields while they are redacted, and hides Send', () => {
    expect(src).toMatch(/const moneyFields = financialsHidden \? \{\} : \{/)
    expect(src).toMatch(/canSend && !financialsHidden/)
  })
})

describe('CO-D: exception ledger tolerates a flag that already has a row', () => {
  const src = readFileSync('app/api/co/[id]/exception/route.ts', 'utf8')
  it('drops the flag link instead of violating exceptions_log_one_per_flag', () => {
    expect(src).toMatch(/ledgerFlagId = null/)
    expect(src).toMatch(/flag_id:\s+ledgerFlagId/)
  })
})
