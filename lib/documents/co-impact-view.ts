// lib/documents/co-impact-view.ts
//
// The pure half of lib/documents/co-impact.ts: no database access, so the portal page (a client component) can use the very same
// numbers and wording as the PDF.

import { lateFeeReminder } from '@/lib/documents/late-fee'

export interface CoImpactInput {
  taxRate: number
  subtotal: number
  total: number
  contractValueBefore?: number | null
  revisedContractValue?: number | null
  retainerMonthlyNet?: number | null
  /** The monthly retainer as the (tax-inclusive) SOW states it. */
  retainerMonthlyGross?: number | null
  taxInclusive?: boolean | null
  isRetainerRenewal?: boolean | null
}

/**
 * Contract values are always stated NET of tax (tax is never part of what was scoped), so the impact adds this change order's net
 * subtotal, not its tax-inclusive total.
 */
export function coImpactNumbers(d: CoImpactInput) {
  const taxApplies = d.taxRate > 0
  const netChange = taxApplies ? d.subtotal : d.total
  const exTax = taxApplies ? ' (excl. tax)' : ''
  const revisedValue = d.revisedContractValue != null
    ? d.revisedContractValue
    : d.contractValueBefore != null ? d.contractValueBefore + netChange : null
  const oneTimeOnRetainer = d.retainerMonthlyNet != null
  const isRenewal = !!d.isRetainerRenewal
  // A tax-inclusive SOW states its fees tax included, so a one-time change order on its retainer is shown on that same basis
  // (monthly fee and one-time fee both "incl. tax") instead of flipping to net figures in the middle of a tax-inclusive set.
  const inclusiveRetainerView = oneTimeOnRetainer && taxApplies && d.taxInclusive === true && d.retainerMonthlyGross != null && d.retainerMonthlyGross > 0
  const delta = revisedValue != null && d.contractValueBefore != null ? (isRenewal ? revisedValue - d.contractValueBefore : netChange) : null
  return { taxApplies, netChange, exTax, revisedValue, oneTimeOnRetainer, isRenewal, delta, inclusiveRetainerView }
}

/**
 * The sentences that say when a change order is invoiced and how late payment is treated. One wording for the PDF and the page the
 * client accepts on. `payment` is the full statement; `lateOnly` is the late-fee reminder alone when no payment period is known.
 */
export function coPaymentStatement(d: {
  isRetainerRenewal?: boolean | null; isCredit?: boolean | null; total: number
  paymentTermsDays?: number | null; lateFeeRate?: number | null; sowNumber?: string | null
  invoiceTiming?: 'on_acceptance' | 'on_delivery' | null
}): { payment: string | null; lateOnly: string | null } {
  const charges = !d.isRetainerRenewal && !d.isCredit && d.total > 0
  const days = d.paymentTermsDays || 0
  const late = d.lateFeeRate ? lateFeeReminder(d.lateFeeRate, d.sowNumber) : null
  if (charges && days > 0) {
    const when = d.invoiceTiming === 'on_delivery' ? 'the work is delivered' : 'it is accepted'
    return { payment: `Payment: this change order is invoiced separately once ${when}, and each invoice is due within ${days} day${days === 1 ? '' : 's'} of its invoice date.${late ? ` ${late}` : ''}`, lateOnly: null }
  }
  return { payment: null, lateOnly: charges && late ? late : null }
}

/**
 * The sentences that tie a change order to the agreement it amends. One wording for the PDF and the page the client accepts on.
 * `amends` names the SOW; `coverage` says that what the change order adds is a deliverable under that SOW, so the SOW's
 * ownership and confidentiality terms reach it even though the SOW's own text predates it. Only a change order that adds paid
 * work gets `coverage` (not a credit, not a retainer-rate renewal).
 */
export function coAmendmentStatement(d: {
  sowNumber?: string | null; isRetainerRenewal?: boolean | null; isCredit?: boolean | null; total: number
}): { amends: string | null; coverage: string | null } {
  if (!d.sowNumber) return { amends: null, coverage: null }
  const addsWork = !d.isRetainerRenewal && !d.isCredit && d.total > 0
  return {
    amends: `This change order amends SOW No. ${d.sowNumber}. Except as expressly amended here, all terms of that SOW remain unchanged and in full force.`,
    coverage: addsWork
      ? 'Work added by this change order is a deliverable under that SOW and is covered by its intellectual property and confidentiality provisions.'
      : null,
  }
}
