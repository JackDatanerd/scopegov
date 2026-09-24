import { describe, it, expect } from 'vitest'
import { parseTableAmount as p } from '@/lib/sow/table-schema'
import { validateSowForSend, amountsMentioned } from '@/lib/sow/validate-send'

describe('parseTableAmount', () => {
  it('reads US and European number formats', () => {
    expect(p('1,500.00')).toBe(1500)
    expect(p('1.500,00')).toBe(1500)
    expect(p('1 500,00')).toBe(1500)
    expect(p('1500,50')).toBe(1500.5)
    expect(p('$2,500')).toBe(2500)
    expect(p('€ 2.500,00')).toBe(2500)
    expect(p('KES 150,000')).toBe(150000)
    expect(p('1.500')).toBe(1500)        // three digits after a lone separator = thousands
    expect(p('1.5')).toBe(1.5)
    expect(p('1.500.000')).toBe(1500000)
    expect(p("1'500.50")).toBe(1500.5)
    expect(p('0.500')).toBe(0.5)
  })
  it('refuses ambiguous cells instead of gluing digits together', () => {
    expect(p('Net 30: 500')).toBeNull()
    expect(p('10-15')).toBeNull()
    expect(p('1e3')).toBeNull()
    expect(p('')).toBeNull()
    expect(p('TBD')).toBeNull()
  })
  it('handles shorthand, numbers and sign', () => {
    expect(p('1.5k')).toBe(1500)
    expect(p(250)).toBe(250)
    expect(p('-500')).toBe(-500)
    // FIX (fix round, SOW-B1): this used to assert 500 — literally codifying the
    // bug where accounting-style parens never actually got detected as negative
    // (only a literal '-' character ever did, despite the function's own comment
    // always having claimed "(500)" was handled). Now genuinely negative.
    expect(p('(500)')).toBe(-500)
    expect(p('($500)')).toBe(-500)
    expect(p('500 (refund)')).toBe(500) // trailing annotation, not a wrapping paren — stays positive
  })
})

// FIX (section-9 re-audit, independent pass): 'parties', 'governing_law' and
// 'signature' are now checked for non-empty content too (same treatment as
// oos/payment) — the fixture needs real content for all three or every
// existing "passes cleanly" assertion below would start failing for the
// wrong reason.
const good = () => [
  { id: 'parties', visible: true, content: '<p>Agency and Client.</p>' },
  { id: 'deliverables', visible: true, content: '', table: [{ deliverable: 'Marketing site' }] },
  { id: 'oos', visible: true, content: '<p>Hosting</p>' },
  { id: 'payment', visible: true, content: '<p>Total USD 10,000.00 payable 50/50.</p>' },
  { id: 'governing_law', visible: true, content: '<p>Governed by the laws of Kenya.</p>' },
  { id: 'signature', visible: true, content: '<p>By signing below, both parties agree.</p>' },
]

const byId = (sections: any[], id: string) => sections.find(s => s.id === id)

describe('validateSowForSend', () => {
  it('passes a complete SOW with no warnings', () => {
    const r = validateSowForSend({ sections: good(), metadata: {}, contractValue: 10000 })
    expect(r.errors).toHaveLength(0)
    expect(r.warnings).toHaveLength(0)
  })
  it('blocks a zero contract value', () => {
    expect(validateSowForSend({ sections: good(), metadata: {}, contractValue: 0 }).errors).toHaveLength(1)
  })
  it('blocks empty Out of Scope and empty deliverables', () => {
    const s = good(); byId(s, 'deliverables').table = []; byId(s, 'oos').content = '<p></p>'
    expect(validateSowForSend({ sections: s, metadata: {}, contractValue: 10000 }).errors).toHaveLength(2)
  })
  it('warns (does not block) when Payment Terms omit the contract value, in US or EU format', () => {
    const s = good(); byId(s, 'payment').content = '<p>Total USD 8,000 payable.</p>'
    const r = validateSowForSend({ sections: s, metadata: {}, contractValue: 10000 })
    expect(r.errors).toHaveLength(0)
    expect(r.warnings).toHaveLength(1)
    byId(s, 'payment').content = '<p>Gesamt 10.000,00 EUR</p>'
    expect(validateSowForSend({ sections: s, metadata: {}, contractValue: 10000 }).warnings).toHaveLength(0)
  })
  // FIX (section-9 re-audit, independent pass): flagship finding — parties/
  // governing_law/signature are required (can't be hidden — see
  // REQUIRED_SECTION_IDS in lib/sow/sections.ts) but their content could be
  // emptied via the generic PATCH content-edit path with nothing here ever
  // refusing to send them blank. governing_law is the most material: this
  // app hard-blocks GENERATION entirely without a governing law, so it
  // should equally refuse to SEND one with that section wiped empty.
  it('blocks empty Parties, Governing Law and Signature sections', () => {
    const s = good()
    byId(s, 'parties').content = ''
    byId(s, 'governing_law').content = '<p></p>'
    byId(s, 'signature').content = ''
    const r = validateSowForSend({ sections: s, metadata: {}, contractValue: 10000 })
    expect(r.errors).toHaveLength(3)
    expect(r.errors.some(e => e.includes('Governing Law'))).toBe(true)
  })
  it('requires a milestone schedule to foot to the contract value', () => {
    const s: any[] = [...good(), { id: 'payment_schedule', visible: true, table: [{ milestone: 'A', amount: '6.000,00' }, { milestone: 'B', amount: '4.000,00' }] }]
    const meta = { paymentStructure: 'milestones' }
    expect(validateSowForSend({ sections: s, metadata: meta, contractValue: 10000 }).errors).toHaveLength(0)
    byId(s, 'payment_schedule').table[1].amount = '3.000,00'
    expect(validateSowForSend({ sections: s, metadata: meta, contractValue: 10000 }).errors).toHaveLength(1)
    byId(s, 'payment_schedule').table[1].amount = 'later'
    expect(validateSowForSend({ sections: s, metadata: meta, contractValue: 10000 }).errors[0]).toContain('read the amount')
  })
  // FIX (fix round, SOW-B3): the footing check used to only sum rows with a
  // strictly positive amount, silently dropping a legitimate negative
  // "credit" milestone from the total — so a schedule that visibly footed
  // (and that SowEditor's own running total agreed footed) could still be
  // rejected here. Every named row counts now, whatever its sign.
  it('foots a schedule containing a negative credit milestone', () => {
    const s: any[] = [...good(), { id: 'payment_schedule', visible: true, table: [
      { milestone: 'Deposit', amount: '12,000' },
      { milestone: 'Early-bird credit', amount: '-2,000' },
    ] }]
    const meta = { paymentStructure: 'milestones' }
    expect(validateSowForSend({ sections: s, metadata: meta, contractValue: 10000 }).errors).toHaveLength(0)
  })
  it('amountsMentioned finds every figure in prose', () => {
    expect(amountsMentioned('pay 50% of 1,500.50 by 30 June')).toContain(1500.5)
  })
})
