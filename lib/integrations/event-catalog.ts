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

/** A sample in the exact shape a real delivery has. Ids are fixed, obviously-fake UUIDs. */
export function sampleEnvelope(info: EventInfo): Record<string, unknown> {
  return {
    id: '5b0c2d52-8c4e-4e5a-9d0c-0123456789ab',
    type: info.type,
    created_at: '2026-01-15T09:30:00.000Z',
    workspace_id: '0f1e2d3c-4b5a-4968-8776-655443322110',
    project_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
    entity: { type: 'project', id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d' },
    project: { id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', name: 'Website Redesign', status: 'Active' },
    client: { id: '9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f', name: 'Acme Ltd' },
    data: { title: info.sampleTitle, summary: info.sampleSummary },
  }
}
