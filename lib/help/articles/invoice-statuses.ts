// lib/help/articles/invoice-statuses.ts
// Checked against the product code on 2026-10-29: lib/utils/format.ts (status labels), cron/payment-overdue (step 1b),
// api/invoices/[id] (void, remind, dispute-resolve), portal invoice routes (dispute, paid), BillingTab.

import type { HelpArticle } from '../types'

export const invoiceStatuses: HelpArticle = {
  slug: 'invoice-statuses',
  title: 'Overdue, disputed and paid: what each invoice status means',
  summary: 'Learn what moves an invoice between statuses, and what to do when a client says they paid or raises a question.',
  category: 'invoicing',
  order: 4,
  audience: { permissions: ['VIEW_FINANCIALS', 'SEND_INVOICES'], plan: 'all' },
  shortAnswer:
    'An invoice is a **Draft**, then **Awaiting payment**, then **Partially paid** or **Paid**, or **Overdue** if the due date passes with money still owed. **Void** is for invoices you cancel. ' +
    '"Disputed" and "Client says paid" are notes on top of the status, not statuses of their own.',
  beforeYouStart: [
    'Permission to view financials to see invoices, and to send invoices to remind, record payments, void or resolve a dispute.',
  ],
  steps: [
    {
      title: 'Know the statuses',
      body: 'The status pill on each invoice tells you where it stands.',
      details: [
        '**Draft**: not sent. You can edit or delete it.',
        '**Awaiting payment**: sent, nothing received yet.',
        '**Partially paid**: some money recorded, balance still due.',
        '**Paid**: the full amount is recorded.',
        '**Overdue**: past its due date with a balance. ScopeGov checks once a day, so it flips the morning after the due date.',
        '**Void**: cancelled. The client\u2019s link stops working.',
      ],
    },
    {
      title: 'When an invoice goes overdue',
      body: 'People with financial access get a bell notification and an email. You can still record payments on an overdue invoice.',
      details: [
        'Click **Remind** to email the client a reminder with the link.',
        'Reminders are rate-limited, so a second click soon after may be refused.',
      ],
    },
    {
      title: 'When the client says they paid',
      body: 'The client can click **I\u2019ve already paid this** and add a reference. The invoice shows a **Client says paid** note with the date, and automatic reminders pause.',
      details: [
        'Check your bank. If the money is there, click **Record payment**. That clears the note.',
        'If you click **Remind** while a claim is open you are asked \u201cSend the reminder anyway?\u201d.',
      ],
    },
    {
      title: 'When the client raises a question',
      body: 'The client can click **Question about this invoice?** and describe the issue (at least 10 characters). You are notified, and the invoice shows **Client disputed**.',
      details: [
        'A dispute does not change the status. The invoice can still go overdue, and the overdue alert says it is disputed.',
        'Answer the client directly, fix the invoice if needed, then click **Resolve dispute** and add a note. The pill changes to **Dispute resolved** and the client sees when it was resolved.',
        'The client can raise a new question later with **Still have a question?**.',
      ],
    },
    {
      title: 'Cancel an invoice with Void',
      body: 'Click **Void** on a sent invoice. The client\u2019s link stops working. This cannot be undone.',
      details: [
        'If money has already been received, you must give a reason, and the payments stay on file. Refund or credit the client separately.',
        'A draft is deleted, not voided. A fully paid invoice cannot be voided.',
      ],
    },
  ],
  dos: [
    'Resolve a dispute before chasing payment on that invoice.',
    'Record payments promptly so the status stays honest.',
    'Add a clear reason when you void.',
    'Check for a **Client says paid** note before sending another reminder.',
  ],
  donts: [
    'Do not void an invoice to \u201cedit\u201d it unless the client has not paid. Void, then raise a corrected one.',
    'Do not ignore a dispute. The invoice will go overdue with the question still open.',
    'Do not treat **Client says paid** as proof. Only recording a payment marks it paid.',
    'Do not expect a voided invoice to be reopened. Create a new one.',
  ],
  problems: [
    {
      symptom: 'The invoice is still **Awaiting payment** after the due date',
      meaning: 'The overdue check runs once a day.',
      fix: 'It updates the next morning.',
    },
    {
      symptom: 'Remind asks \u201cSend the reminder anyway?\u201d',
      meaning: 'The client has an open dispute or says they already paid.',
      fix: 'Resolve the dispute or check for the payment first, or send it anyway if you are sure.',
    },
    {
      symptom: '\u201cCan only remind on unpaid, sent invoices\u201d',
      meaning: 'The invoice is a draft, paid or void.',
      fix: 'Reminders only apply to unpaid sent invoices.',
    },
    {
      symptom: '\u201cA draft invoice was never sent \u2014 delete it instead of voiding it\u201d',
      meaning: 'Drafts are removed with **Delete**.',
      fix: 'Click **Delete**.',
    },
    {
      symptom: '\u201cA fully paid invoice cannot be voided\u201d',
      meaning: 'It is the record of a completed sale.',
      fix: 'Record a refund or credit note outside ScopeGov and keep the invoice.',
    },
  ],
  whatHappensNext: [
    'A paid invoice stays in your list and your export as the record.',
    'A voided invoice stays too, marked void, with its payment history if any.',
    'Every status change is recorded in the audit log.',
  ],
  related: ['payments-and-over-contract', 'create-an-invoice', 'export-invoices'],
  updated: '2026-10-29',
}
