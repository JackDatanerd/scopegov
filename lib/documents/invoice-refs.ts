// lib/documents/invoice-refs.ts
//
// Which SOW an invoice is "for services under". An invoice stores exactly one of milestone_id / sow_id / co_id, so a
// milestone invoice (the upfront and final payments created when a SOW is signed) has NO sow_id and its PDF printed no SOW
// reference at all — which is exactly what matters when a client has more than one signed SOW. Resolve it the way the data is
// actually linked: directly, else through the milestone (payment_milestones.sow_id is NOT NULL), else, for a change-order
// invoice, through the amendment the accepted change order recorded (amendments.signed_sow_id).
//
import { normalizeLateFeeRate } from '@/lib/documents/late-fee'

// Never throws: a failed lookup just means no reference line, same as before.

export const INVOICE_SOW_EMBEDS = 'sow_documents(document_number, metadata), payment_milestones(sow_documents(document_number, metadata))'

export interface InvoiceSowTerms { number: string | null; lateFeeRate: number | null }

/** The SOW an invoice sits under and the late fee that SOW froze at drafting (null when none). */
export async function resolveInvoiceSowTerms(service: any, invoice: any): Promise<InvoiceSowTerms> {
  const pick = (sow: any): InvoiceSowTerms | null =>
    sow?.document_number ? { number: String(sow.document_number), lateFeeRate: normalizeLateFeeRate(sow?.metadata?.lateFeeRate) } : null
  const direct = pick(invoice?.sow_documents) || pick(invoice?.payment_milestones?.sow_documents)
  if (direct) return direct
  if (invoice?.co_id) {
    try {
      const { data } = await service
        .from('amendments').select('sow_documents(document_number, metadata)')
        .eq('change_order_id', invoice.co_id).limit(1).maybeSingle()
      const viaAmendment = pick(data?.sow_documents)
      if (viaAmendment) return viaAmendment
    } catch (e) {
      console.error('invoice SOW reference lookup failed (printing no reference):', e)
    }
  }
  return { number: null, lateFeeRate: null }
}

export async function resolveInvoiceSowNumber(service: any, invoice: any): Promise<string | null> {
  return (await resolveInvoiceSowTerms(service, invoice)).number
}
