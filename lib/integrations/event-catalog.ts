// lib/integrations/event-catalog.ts
//
// Human names, descriptions and sample payloads for every integration event. Used by the Zapier app (as trigger names
// and the sample data Zapier needs to map fields) and by the "sample" endpoint. Kept free of server imports and of
// path aliases so scripts/gen-zapier-events.mjs can load it directly under Node.

export interface EventInfo { type: string; label: string; description: string; sampleTitle: string; sampleSummary: string }

export const EVENT_CATALOG: readonly EventInfo[] = [
  { type: 'sow.signed', label: 'SOW Signed', description: 'Triggers when a client signs a statement of work.', sampleTitle: 'SOW signed — Website Redesign', sampleSummary: 'Acme Ltd signed the statement of work for "Website Redesign".' },
  { type: 'sow.declined', label: 'SOW Declined', description: 'Triggers when a client declines a statement of work.', sampleTitle: 'SOW declined — Website Redesign', sampleSummary: 'Acme Ltd declined the statement of work for "Website Redesign".' },
  { type: 'sow.changes_requested', label: 'SOW Changes Requested', description: 'Triggers when a client asks for changes to a statement of work.', sampleTitle: 'Changes requested — Website Redesign', sampleSummary: 'Acme Ltd asked for changes to the statement of work.' },
  { type: 'sow.expired', label: 'SOW Expired', description: 'Triggers when a statement of work\'s signing link expires unsigned.', sampleTitle: 'SOW expired — Website Redesign', sampleSummary: 'The signing link for "Website Redesign" expired before it was signed.' },
  { type: 'sow.stalled', label: 'SOW Stalled', description: 'Triggers when a statement of work has sat unsigned long enough to stall the project.', sampleTitle: 'SOW stalled — Website Redesign', sampleSummary: 'The statement of work has been unsigned for 7 days.' },
  { type: 'change_order.accepted', label: 'Change Order Accepted', description: 'Triggers when a client accepts a change order.', sampleTitle: 'Change order accepted — Website Redesign', sampleSummary: 'Acme Ltd accepted a change order.' },
  { type: 'change_order.declined', label: 'Change Order Declined', description: 'Triggers when a client declines a change order.', sampleTitle: 'Change order declined — Website Redesign', sampleSummary: 'Acme Ltd declined a change order.' },
  { type: 'change_order.countered', label: 'Change Order Countered', description: 'Triggers when a client counters a change order.', sampleTitle: 'Change order countered — Website Redesign', sampleSummary: 'Acme Ltd sent a counter-proposal on a change order.' },
  { type: 'change_order.expired', label: 'Change Order Expired', description: 'Triggers when a change order expires unanswered.', sampleTitle: 'Change order expired — Website Redesign', sampleSummary: 'A change order expired before the client answered.' },
  { type: 'change_order.stalled', label: 'Change Order Stalled', description: 'Triggers when a change order has gone unanswered for too long.', sampleTitle: 'Change order stalled — Website Redesign', sampleSummary: 'A change order has had no answer for 5 days.' },
  { type: 'guardian.flag_raised', label: 'Scope Flag Raised', description: 'Triggers when Guardian flags a client request as outside the signed scope.', sampleTitle: 'Scope flag — Website Redesign', sampleSummary: 'Guardian flagged a request as outside the signed scope.' },
  { type: 'guardian.flag_stalled', label: 'Scope Flag Stalled', description: 'Triggers when a scope flag has been left unresolved for too long.', sampleTitle: 'Scope flag unresolved — Website Redesign', sampleSummary: 'A scope flag has been open for several days.' },
  { type: 'invoice.sent', label: 'Invoice Sent', description: 'Triggers when an invoice is sent to a client.', sampleTitle: 'Invoice sent — Website Redesign', sampleSummary: 'Invoice "Milestone 1" was sent to Acme Ltd.' },
  { type: 'invoice.paid', label: 'Invoice Paid', description: 'Triggers when a payment is recorded against an invoice.', sampleTitle: 'Invoice paid in full — Website Redesign', sampleSummary: 'Acme Ltd paid $2,500.00 on "Milestone 1".' },
  { type: 'invoice.payment_claimed', label: 'Invoice Payment Claimed', description: 'Triggers when a client says they have paid, from the invoice link.', sampleTitle: 'Payment claimed — Website Redesign', sampleSummary: 'Acme Ltd says they have paid "Milestone 1".' },
  { type: 'invoice.overdue', label: 'Invoice Overdue', description: 'Triggers when an invoice passes its due date unpaid.', sampleTitle: 'Invoice overdue — Website Redesign', sampleSummary: 'Invoice "Milestone 1" is overdue.' },
  { type: 'invoice.disputed', label: 'Invoice Disputed', description: 'Triggers when a client disputes an invoice.', sampleTitle: 'Invoice disputed — Website Redesign', sampleSummary: 'Acme Ltd disputed "Milestone 1".' },
  { type: 'milestone.overdue', label: 'Payment Milestone Overdue', description: 'Triggers when a payment milestone is overdue.', sampleTitle: 'Milestone overdue — Website Redesign', sampleSummary: 'A payment milestone is past due.' },
  { type: 'retainer.ending', label: 'Retainer Ending', description: 'Triggers when a retainer is close to ending.', sampleTitle: 'Retainer ending — Monthly Support', sampleSummary: 'The retainer ends soon.' },
]

const ID = {
  sow: '3c1f0a52-7d84-4b6e-9a21-5e0d8c7b4a10', co: '6e2b9d14-1a73-4c58-8f0e-2d9a7b3c5e41', invoice: '8a4d6f20-5b19-4e37-a6c2-1f0b9d8e7c53',
  milestone: '2f7c1e96-4d03-4a8b-b5e1-9c6a0d3f8b27', flag: '9b5e3a71-0c48-4d26-8e1f-7a2c6d0b4f95',
}
const T = { sent: '2026-01-08T10:00:00.000Z', done: '2026-01-15T09:30:00.000Z', due: '2026-02-07' }
const sowDoc = (status: string, extra: Record<string, unknown> = {}) => ({ type: 'sow', id: ID.sow, number: 'SOW-0007', version: 1, status, sent_at: T.sent, signed_at: null, expires_at: '2026-01-22T10:00:00.000Z', ...extra })
const coDoc = (status: string, extra: Record<string, unknown> = {}) => ({ type: 'change_order', id: ID.co, number: 'CO-0003', title: 'Second landing page', version: 1, status, total: 1800, currency: 'USD', is_credit: false, is_retainer_renewal: false, sent_at: T.sent, accepted_at: null, expires_at: '2026-01-22T10:00:00.000Z', ...extra })
const flagDoc = (extra: Record<string, unknown> = {}) => ({ type: 'guardian_flag', id: ID.flag, severity: 'medium', status: 'open', flag_type: 'scope_creep', description: 'The client asked for a second landing page, which is not in the signed scope.', sow_reference: 'Section 2.1', raised_at: T.done, ...extra })
const invDoc = (extra: Record<string, unknown> = {}) => ({ type: 'invoice', id: ID.invoice, number: 'INV-0042', title: 'Milestone 1', status: 'sent', amount: 2500, amount_paid: 0, balance_due: 2500, currency: 'USD', due_date: T.due, sent_at: T.sent, paid_at: null, ...extra })

/** Event-specific structured fields (the part of `data` beyond title/summary). Mirrors what the call sites + enrich.ts produce. */
export function sampleData(type: string): Record<string, unknown> {
  switch (type) {
    case 'sow.signed': return { document: sowDoc('signed', { signed_at: T.done }), signed_by: 'Jane Doe' }
    case 'sow.declined': return { document: sowDoc('declined'), reason: 'The timeline does not work for us.' }
    case 'sow.changes_requested': return { document: sowDoc('changes_requested'), feedback: 'Please split phase 2 into two milestones.', new_version: 2 }
    case 'sow.expired': return { document: sowDoc('expired') }
    case 'sow.stalled': return { document: sowDoc('awaiting_signature'), days_unsigned: 7 }
    case 'change_order.accepted': return { document: coDoc('accepted', { accepted_at: T.done }), accepted_by: 'Jane Doe' }
    case 'change_order.declined': return { document: coDoc('declined'), reason: 'Out of budget this quarter.' }
    case 'change_order.countered': return { document: coDoc('countered'), counter_amount: 1500, counter_note: 'Could we do it for 1,500?' }
    case 'change_order.expired': return { document: coDoc('expired') }
    case 'change_order.stalled': return { document: coDoc('sent'), days_unanswered: 5 }
    case 'guardian.flag_raised': return { document: flagDoc() }
    case 'guardian.flag_stalled': return { document: flagDoc(), days_open: 3 }
    case 'invoice.sent': return { document: invDoc() }
    case 'invoice.paid': return { document: invDoc({ status: 'paid', amount_paid: 2500, balance_due: 0, paid_at: T.done }), payment: { amount: 2500, method: 'bank_transfer', paid_at: T.done }, fully_paid: true, balance_remaining: 0 }
    case 'invoice.payment_claimed': return { document: invDoc(), claim_reference: 'TRX-88213', claim_note: 'Paid by bank transfer this morning.' }
    case 'invoice.overdue': return { document: invDoc({ status: 'overdue' }), balance_due: 2500, under_dispute: false }
    case 'invoice.disputed': return { document: invDoc({ status: 'sent' }), dispute_note: 'The second line item looks wrong.' }
    case 'milestone.overdue': return { document: { type: 'payment_milestone', id: ID.milestone, title: 'Design sign-off', amount: 1200, currency: 'USD', due_date: T.due, status: 'overdue', milestone_type: 'milestone' } }
    case 'retainer.ending': return { retainer: { term_months: 12, months_completed: 12 } }
    default: return {}
  }
}

/** A sample in the exact shape a real delivery has. Ids are fixed, obviously-fake UUIDs. */
export function sampleEnvelope(info: EventInfo): Record<string, unknown> {
  return {
    id: '5b0c2d52-8c4e-4e5a-9d0c-0123456789ab',
    type: info.type,
    created_at: '2026-01-15T09:30:00.000Z',
    workspace_id: '0f1e2d3c-4b5a-4968-8776-655443322110',
    project_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
    entity: { type: 'project', id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d' },
    project: { id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', name: 'Website Redesign', status: 'Active', currency: 'USD' },
    client: { id: '9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f', name: 'Acme Ltd' },
    data: { ...sampleData(info.type), title: info.sampleTitle, summary: info.sampleSummary },
  }
}
