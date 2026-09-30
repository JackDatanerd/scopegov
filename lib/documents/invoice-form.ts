// lib/documents/invoice-form.ts
//
// Pure helpers behind components/invoices/BillingTab.tsx's two invoice forms, kept out of the
// component so they can be unit-tested.
//
// FIX (section-12 independent pass 12 — bug 1): a milestone's amount is PRE-TAX (the server's cap
// check compares the invoice's pre-tax subtotal against it, and payment_milestones.tax_rate is always
// 0 — post-signing.ts writes it that way). The form's amount field, though, means the GROSS when the
// invoice is tax-inclusive. Pre-filling the raw milestone amount into an inclusive, taxed form made
// the invoice's subtotal come out BELOW the milestone (1,000 @ 16% inclusive -> subtotal 862.07),
// after which the milestone flips to 'invoiced' and the remainder can never be billed. The CO branch
// already grossed up for this reason; milestones now do the same.
//
// FIX (section-12 independent pass 12 — bug 3): the edit form always sent every field, so PATCH
// treated every save as a money change and re-ran the per-source caps and the project-level
// over-contract check even for a title or PO-number fix. buildInvoiceEditPatch() sends only what
// actually changed, and the money block (amount + tax + line items, which must travel together)
// only when something in it changed.

import { roundCurrency } from '@/lib/utils/format'

/** The figure to put in the "Amount" field so the invoice's pre-tax subtotal equals `net`. */
export function amountFieldForNet(net: number, taxRate: number, taxInclusive: boolean): number {
  const n = Number(net) || 0
  const rate = Number(taxRate) || 0
  return taxInclusive && rate > 0 ? roundCurrency(n * (1 + rate / 100)) : n
}

export interface EditLine { description: string; quantity: number; rate: number }

export interface EditFormState {
  title: string
  /** Text of the Amount input (ignored while itemized — it mirrors the line-item sum). */
  amount: string
  dueDate: string
  poNumber: string
  paymentInstructions: string
  taxRate: string
  taxInclusive: boolean
  itemized: boolean
  /** Already filtered to rows with a description. */
  lineItems: EditLine[]
}

const sameLines = (a: EditLine[], b: EditLine[]) =>
  a.length === b.length && a.every((l, i) =>
    l.description.trim() === b[i].description.trim()
    && Number(l.quantity) === Number(b[i].quantity)
    && Number(l.rate) === Number(b[i].rate))

/** Request body for PATCH /api/invoices/[id]: changed fields only. {} = nothing to save. */
export function buildInvoiceEditPatch(initial: EditFormState, current: EditFormState): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (current.title.trim() !== initial.title.trim()) body.title = current.title.trim()
  if (current.dueDate !== initial.dueDate) body.dueDate = current.dueDate || null
  if (current.poNumber.trim() !== initial.poNumber.trim()) body.poNumber = current.poNumber.trim() || null
  if (current.paymentInstructions !== initial.paymentInstructions) body.paymentInstructions = current.paymentInstructions

  const itemizedNow = current.itemized
  const moneyChanged =
    itemizedNow !== initial.itemized
    || (Number(current.taxRate) || 0) !== (Number(initial.taxRate) || 0)
    || (!itemizedNow && current.taxInclusive !== initial.taxInclusive)
    || (itemizedNow
        ? !sameLines(current.lineItems, initial.lineItems)
        : Number(current.amount) !== Number(initial.amount))
  if (moneyChanged) {
    body.amount = Number(current.amount)
    body.taxRate = Number(current.taxRate) || 0
    body.taxInclusive = itemizedNow ? false : current.taxInclusive
    body.lineItems = itemizedNow ? current.lineItems : []
  }
  return body
}
