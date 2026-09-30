import { describe, it, expect } from 'vitest'
import { amountFieldForNet, buildInvoiceEditPatch, type EditFormState } from '@/lib/documents/invoice-form'
import { computeInvoiceTotals } from '@/lib/documents/invoice-totals'

describe('milestone prefill (pass 12, bug 1)', () => {
  it('grosses a pre-tax milestone up when the invoice is tax-inclusive, so the subtotal matches it', () => {
    const field = amountFieldForNet(1000, 16, true)
    expect(field).toBe(1160)
    const r: any = computeInvoiceTotals({ entered: field, taxRate: 16, taxInclusive: true })
    expect(r.totals.subtotal).toBe(1000)
  })
  it('round-trips awkward amounts to within the 0.01 cap tolerance', () => {
    for (const net of [333.33, 1234.56, 0.99, 71000, 49.95]) {
      const r: any = computeInvoiceTotals({ entered: amountFieldForNet(net, 16, true), taxRate: 16, taxInclusive: true })
      expect(Math.abs(r.totals.subtotal - net)).toBeLessThanOrEqual(0.01)
    }
  })
  it('leaves the amount alone for tax-exclusive or untaxed invoices', () => {
    expect(amountFieldForNet(1000, 16, false)).toBe(1000)
    expect(amountFieldForNet(1000, 0, true)).toBe(1000)
  })
})

const base: EditFormState = {
  title: 'Milestone 2', amount: '1160', dueDate: '2026-10-30', poNumber: '', paymentInstructions: '<p>Bank</p>',
  taxRate: '16', taxInclusive: true, itemized: false, lineItems: [],
}

describe('edit patch (pass 12, bug 3)', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildInvoiceEditPatch(base, { ...base })).toEqual({})
  })
  it('a title fix sends only the title — no money fields', () => {
    expect(buildInvoiceEditPatch(base, { ...base, title: 'Milestone 2 — Design' })).toEqual({ title: 'Milestone 2 — Design' })
  })
  it('clearing the due date / PO sends null', () => {
    expect(buildInvoiceEditPatch({ ...base, poNumber: 'PO-1' }, { ...base, poNumber: '', dueDate: '' }))
      .toEqual({ poNumber: null, dueDate: null })
  })
  it('an amount or tax change sends the whole money block together', () => {
    const p = buildInvoiceEditPatch(base, { ...base, amount: '1200' })
    expect(p).toMatchObject({ amount: 1200, taxRate: 16, taxInclusive: true, lineItems: [] })
    expect(p.title).toBeUndefined()
    expect(buildInvoiceEditPatch(base, { ...base, taxRate: '8' })).toMatchObject({ amount: 1160, taxRate: 8 })
  })
  it('itemized: unchanged lines send no money; edited lines send the block with tax-exclusive', () => {
    const items = [{ description: 'Hours', quantity: 10, rate: 100 }]
    const it0: EditFormState = { ...base, itemized: true, taxInclusive: false, amount: '1000', lineItems: items }
    expect(buildInvoiceEditPatch(it0, { ...it0, amount: '1000.0000001' })).toEqual({})
    const p = buildInvoiceEditPatch(it0, { ...it0, amount: '1100', lineItems: [{ ...items[0], quantity: 11 }] })
    expect(p).toMatchObject({ amount: 1100, taxInclusive: false, lineItems: [{ description: 'Hours', quantity: 11, rate: 100 }] })
  })
  it('turning itemizing off sends an empty line list', () => {
    const items = [{ description: 'Hours', quantity: 10, rate: 100 }]
    const it0: EditFormState = { ...base, itemized: true, taxInclusive: false, amount: '1000', lineItems: items }
    expect(buildInvoiceEditPatch(it0, { ...it0, itemized: false, lineItems: [] })).toMatchObject({ lineItems: [] })
  })
})
