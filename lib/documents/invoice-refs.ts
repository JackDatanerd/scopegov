// lib/documents/invoice-refs.ts
//
// Which SOW an invoice is "for services under". An invoice stores exactly one of milestone_id / sow_id / co_id, so a
// milestone invoice (the upfront and final payments created when a SOW is signed) has NO sow_id and its PDF printed no SOW
// reference at all — which is exactly what matters when a client has more than one signed SOW. Resolve it the way the data is
// actually linked: directly, else through the milestone (payment_milestones.sow_id is NOT NULL), else, for a change-order
// invoice, through the amendment the accepted change order recorded (amendments.signed_sow_id).
//
// Never throws: a failed lookup just means no reference line, same as before.

export const INVOICE_SOW_EMBEDS = 'sow_documents(document_number), payment_milestones(sow_documents(document_number))'

export async function resolveInvoiceSowNumber(service: any, invoice: any): Promise<string | null> {
  const direct = invoice?.sow_documents?.document_number
  if (direct) return String(direct)
  const viaMilestone = invoice?.payment_milestones?.sow_documents?.document_number
  if (viaMilestone) return String(viaMilestone)
  if (invoice?.co_id) {
    try {
      const { data } = await service
        .from('amendments').select('sow_documents(document_number)')
        .eq('change_order_id', invoice.co_id).limit(1).maybeSingle()
      const n = data?.sow_documents?.document_number
      if (n) return String(n)
    } catch (e) {
      console.error('invoice SOW reference lookup failed (printing no reference):', e)
    }
  }
  return null
}
