import { describe, it, expect } from 'vitest'
import { finalizeRegeneratedSection, isFixedClauseSection } from '@/lib/sow/regenerated-section'
import { coImpactNumbers, coPaymentStatement } from '@/lib/documents/co-impact-view'
import { documentDateLocale } from '@/lib/utils/date-style'
import { displayTableRows } from '@/lib/sow/display-rows'
import { formatDate } from '@/lib/utils/format'

describe('regenerating one SOW section keeps what drafting guarantees', () => {
  it('fixed English clauses are not model-rewritten without an instruction', () => {
    expect(isFixedClauseSection('termination', null)).toBe(true)
    expect(isFixedClauseSection('dispute', 'en')).toBe(true)
    expect(isFixedClauseSection('termination', 'es')).toBe(false)
    expect(isFixedClauseSection('payment', null)).toBe(false)
  })
  it('restores the portfolio-use paragraph word for word and strips volunteered portfolio wording', () => {
    const para = '<p><strong>Portfolio use.</strong> The Provider may reference the published work as work samples unless the Client objects in writing.</p>'
    const before = `<p>Rights pass on payment.</p>${para}`
    const after = '<p>Rights transfer upon payment in full.</p><p>The Provider may also feature this work in its case studies.</p>'
    const out = finalizeRegeneratedSection({ sectionId: 'ip', before, after })
    expect(out).toContain(para)
    expect(out).not.toMatch(/case studies\./)
    expect(out.match(/Portfolio use\./g)).toHaveLength(1)
  })
  it('does not duplicate a paragraph the rewrite already kept', () => {
    const para = '<p><strong>Client materials.</strong> The Client confirms that it owns the materials.</p>'
    const out = finalizeRegeneratedSection({ sectionId: 'ip', before: `<p>A.</p>${para}`, after: `<p>B.</p>${para}` })
    expect(out.match(/Client materials\./g)).toHaveLength(1)
  })
  it('keeps the payment period sentence and the late-fee paragraph', () => {
    const period = '<p>Each invoice is due within 14 days of its invoice date.</p>'
    const late = '<p><strong>Late payment.</strong> Overdue amounts accrue a late fee of 2% per month.</p>'
    const out = finalizeRegeneratedSection({ sectionId: 'payment', before: `${period}${late}`, after: '<p>Invoices fall due on a schedule agreed by the parties.</p>' })
    expect(out).toContain(period)
    expect(out).toContain(late)
  })
  it('keeps the change-order clause in Out of Scope, and the chosen review window in Revisions', () => {
    const oos = finalizeRegeneratedSection({ sectionId: 'oos', before: '<p>Hosting.</p><p>Any of these items may be performed only under a written change order signed by both parties.</p>', after: '<ul><li>Hosting</li></ul>' })
    expect(oos).toMatch(/change order/i)
    const rev = finalizeRegeneratedSection({ sectionId: 'revisions', before: '<p>One round.</p>', after: '<p>One round of edits.</p>', metadata: { approvalSilence: { days: 5 } } })
    expect(rev).toMatch(/5 business days/)
  })
  it('lower-cases an undefined "the Services" but leaves a defined one', () => {
    expect(finalizeRegeneratedSection({ sectionId: 'assumptions', before: '<p>x</p>', after: '<p>This covers the Services listed.</p>', otherSectionsText: ['<p>Plain text.</p>'] })).toContain('the services')
    expect(finalizeRegeneratedSection({ sectionId: 'assumptions', before: '<p>x</p>', after: '<p>This covers the Services listed.</p>', otherSectionsText: ['<p>The work (the "Services") is described below.</p>'] })).toContain('the Services')
  })
  it('leaves a non-English rewrite alone apart from kept paragraphs', () => {
    const out = finalizeRegeneratedSection({ sectionId: 'oos', before: '<p>Alojamiento. Orden de cambio.</p>', after: '<p>Sin alojamiento.</p>', language: 'es' })
    expect(out).toBe('<p>Sin alojamiento.</p>')
  })
})

describe('the CO impact numbers and payment wording are shared', () => {
  const base = { taxRate: 8.25, subtotal: 700, total: 757.75 }
  it('one-time work on a retainer', () => {
    const n = coImpactNumbers({ ...base, retainerMonthlyNet: 1200 })
    expect(n).toMatchObject({ oneTimeOnRetainer: true, netChange: 700, exTax: ' (excl. tax)', taxApplies: true })
  })
  it('a fixed project: net change added to the net before-value', () => {
    const n = coImpactNumbers({ ...base, contractValueBefore: 5000 })
    expect(n.revisedValue).toBe(5700)
    expect(n.delta).toBe(700)
  })
  it('a renewal reports the rate change', () => {
    const n = coImpactNumbers({ taxRate: 0, subtotal: 1500, total: 1500, contractValueBefore: 1200, revisedContractValue: 1500, isRetainerRenewal: true })
    expect(n.delta).toBe(300)
    expect(n.exTax).toBe('')
  })
  it('states when it is invoiced and the late fee', () => {
    const d = { total: 757.75, paymentTermsDays: 14, lateFeeRate: 2, sowNumber: 'SOW-0012' }
    expect(coPaymentStatement(d).payment).toBe('Payment: this change order is invoiced separately once it is accepted, and each invoice is due within 14 days of its invoice date. Overdue amounts accrue a late fee of 2% per month, as set out in SOW No. SOW-0012.')
    expect(coPaymentStatement({ ...d, invoiceTiming: 'on_delivery' }).payment).toContain('once the work is delivered')
  })
  it('says nothing for renewals and credits, and only the late fee when no period is known', () => {
    expect(coPaymentStatement({ total: 100, paymentTermsDays: 14, isRetainerRenewal: true })).toEqual({ payment: null, lateOnly: null })
    expect(coPaymentStatement({ total: -100, paymentTermsDays: 14, isCredit: true })).toEqual({ payment: null, lateOnly: null })
    expect(coPaymentStatement({ total: 100, lateFeeRate: 1.5, sowNumber: 'SOW-1' }).lateOnly).toBe('Overdue amounts accrue a late fee of 1.5% per month, as set out in SOW No. SOW-1.')
  })
})

describe('one date style on screen and on paper', () => {
  it('follows the agency country and the SOW language', () => {
    expect(documentDateLocale(null, 'United States')).toBe('en-US')
    expect(documentDateLocale('en', 'Kenya')).toBe('en-GB')
    expect(documentDateLocale('es', 'United States')).toBe('es')
  })
  it('prints the same calendar date the PDF does', () => {
    expect(formatDate('2026-10-30', { day: 'numeric', month: 'long', year: 'numeric' }, documentDateLocale(null, 'US'))).toBe('October 30, 2026')
    expect(formatDate('2026-10-30', { day: 'numeric', month: 'long', year: 'numeric' }, documentDateLocale(null, 'Kenya'))).toBe('30 October 2026')
    expect(formatDate('2026-10-30', { day: 'numeric', month: 'long', year: 'numeric' })).toBe('30 October 2026')
  })
})

describe('payment schedule rows print in Title Case in English only', () => {
  const rows = [{ milestone: 'Monthly retainer', amount: '1200', trigger: 'Invoiced monthly, in advance' }]
  it('English', () => expect(displayTableRows('payment_schedule', rows, null)[0].milestone).toBe('Monthly Retainer'))
  it('other languages and other tables untouched', () => {
    expect(displayTableRows('payment_schedule', [{ milestone: 'Pago inicial' }], 'es')[0].milestone).toBe('Pago inicial')
    expect(displayTableRows('deliverables', rows, null)).toBe(rows)
  })
  it('never mutates the stored rows', () => {
    displayTableRows('payment_schedule', rows, null)
    expect(rows[0].milestone).toBe('Monthly retainer')
  })
})
