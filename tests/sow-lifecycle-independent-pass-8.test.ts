import { describe, it, expect } from 'vitest'
import { parseTableAmount as p } from '@/lib/sow/table-schema'
import { validateSowForSend, amountsMentioned, amountsStated } from '@/lib/sow/validate-send'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// SOW lifecycle, round 8.

describe('B1 — typographic minus signs read as negative', () => {
  it('reads U+2212, U+2012 and fullwidth/small hyphen-minus as a minus', () => {
    expect(p('\u2212500')).toBe(-500)
    expect(p('\u2212$1,200.50')).toBe(-1200.5)
    expect(p('\u2012500')).toBe(-500)
    expect(p('\uFF0D500')).toBe(-500)
    expect(p('(\u2212500)')).toBe(-500)
  })
  it('reads an en dash as a minus only when nothing but a currency symbol precedes the number', () => {
    expect(p('\u2013500')).toBe(-500)
    expect(p('\u2013 $500')).toBe(-500)
    expect(p('Deposit \u2013 $500')).toBe(500) // prose dash, not a sign
    expect(p('\u2013')).toBeNull()
  })
  it('reads a trailing accounting minus, but not a trailing dash with text after it', () => {
    expect(p('500-')).toBe(-500)
    expect(p('500 \u2212')).toBe(-500)
    expect(p('500 - on signing')).toBe(500)
  })
  it('leaves everything that was already read correctly alone', () => {
    expect(p('-500')).toBe(-500)
    expect(p('(500)')).toBe(-500)
    expect(p('1,500.00')).toBe(1500)
    expect(p('10-15')).toBeNull()
    expect(p('10\u201315')).toBeNull()
    expect(p('500 (refund)')).toBe(500)
    expect(p('1.5k')).toBe(1500)
  })
  it('a schedule with a credit row typed with a typographic minus foots and is not blocked', () => {
    const sections: any[] = [
      { id: 'parties', visible: true, content: '<p>x</p>' },
      { id: 'deliverables', visible: true, content: '', table: [{ deliverable: 'Site' }] },
      { id: 'oos', visible: true, content: '<p>None</p>' },
      { id: 'payment', visible: true, content: '<p>Total USD 1,000.00.</p>' },
      { id: 'governing_law', visible: true, content: '<p>x</p>' },
      { id: 'signature', visible: true, content: '<p>x</p>' },
      { id: 'payment_schedule', visible: true, table: [
        { milestone: 'Deposit', amount: '1,200' }, { milestone: 'Credit', amount: '\u2212200' },
      ] },
    ]
    const r = validateSowForSend({ sections, metadata: { paymentStructure: 'milestones' }, contractValue: 1000 })
    expect(r.errors).toHaveLength(0)
  })
})

describe('B2 — a percentage or day count is not a stated amount', () => {
  const sections = (payment: string): any[] => [
    { id: 'parties', visible: true, content: '<p>x</p>' },
    { id: 'deliverables', visible: true, content: '', table: [{ deliverable: 'Site' }] },
    { id: 'oos', visible: true, content: '<p>None</p>' },
    { id: 'payment', visible: true, content: payment },
    { id: 'governing_law', visible: true, content: '<p>x</p>' },
    { id: 'signature', visible: true, content: '<p>x</p>' },
  ]
  it('still warns when the value only coincides with a percentage / day count', () => {
    expect(validateSowForSend({ sections: sections('<p>100% due before work commences.</p>'), metadata: {}, contractValue: 100 }).warnings).toHaveLength(1)
    expect(validateSowForSend({ sections: sections('<p>50% upfront, 50% on delivery.</p>'), metadata: {}, contractValue: 50 }).warnings).toHaveLength(1)
    expect(validateSowForSend({ sections: sections('<p>Payable net 30 days.</p>'), metadata: {}, contractValue: 30 }).warnings).toHaveLength(1)
    expect(validateSowForSend({ sections: sections('<p>Due within 14 days of invoice.</p>'), metadata: {}, contractValue: 14 }).warnings).toHaveLength(1)
    expect(validateSowForSend({ sections: sections('<p>Includes 2 rounds of revisions.</p>'), metadata: {}, contractValue: 2 }).warnings).toHaveLength(1)
  })
  it('does not warn when the value really is stated, including next to a percentage', () => {
    expect(validateSowForSend({ sections: sections('<p>Total USD 100. 100% due upfront.</p>'), metadata: {}, contractValue: 100 }).warnings).toHaveLength(0)
    expect(validateSowForSend({ sections: sections('<p>Total USD 10,000.00. 50% due upfront, 50% on delivery.</p>'), metadata: {}, contractValue: 10000 }).warnings).toHaveLength(0)
  })
  it('amountsStated drops percentages, durations, rounds and "net N", keeps real amounts', () => {
    expect(amountsStated('USD 12,500.00. 50% due upfront; net 30; within 14 business days; 2 rounds')).toEqual([12500])
    expect(amountsStated('Fee 1.500,00 EUR then 12 500,50 EUR')).toEqual([1500, 12500.5])
    expect(amountsStated('100 percent upfront')).toEqual([])
  })
  it('amountsMentioned itself is unchanged (still every figure)', () => {
    expect(amountsMentioned('The total fee is USD 12,500.00. 50% is due upfront.')).toEqual([12500, 50])
  })
})

// B3 / B4 are structural — assert them on the source so a refactor can't quietly drop them.
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('B3 — the signed-SOW milestone block only replaces the schedule for a milestones structure', () => {
  const renderer = read('lib/pdf/renderer.tsx')
  it('the renderer gates the block on the payment structure', () => {
    expect(renderer).toContain("data.paymentStructure === undefined || data.paymentStructure === 'milestones'")
    expect(renderer).toMatch(/scheduleSectionVisible && structureAllowsMilestoneBlock/)
  })
  it('every SOW PDF render site passes the structure', () => {
    for (const f of [
      'app/api/pdf/sow/[id]/route.ts',
      'app/api/portal/sow/[token]/pdf/route.ts',
      'app/api/portal/sow/[token]/sign/route.ts',
    ]) expect(read(f)).toContain("paymentStructure: sow.metadata?.paymentStructure || '50_50'")
  })
})

describe('B4 — attachment removal is atomic against send / approval', () => {
  it('the route removes through sow_attachment_remove', () => {
    const route = read('app/api/sow/[id]/attachments/[attachmentId]/route.ts')
    expect(route).toContain("rpc('sow_attachment_remove'")
    expect(route).toContain('sow_locked')
    expect(route).toContain('sow_approval_pending')
  })
  it('the migration locks the SOW row, refuses a sent or approval-pending SOW, and scopes the delete to the SOW', () => {
    const sql = read('supabase/migrations/138_sow_attachment_remove_under_lock.sql')
    expect(sql).toContain('FOR UPDATE')
    expect(sql).toContain("RAISE EXCEPTION 'sow_locked'")
    expect(sql).toContain("RAISE EXCEPTION 'sow_approval_pending'")
    expect(sql).toMatch(/WHERE id = p_attachment_id AND sow_id = p_sow_id/)
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sow_attachment_remove(uuid, uuid) TO service_role')
  })
})
