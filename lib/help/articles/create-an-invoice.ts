// lib/help/articles/create-an-invoice.ts
// Checked against the product code on 2026-10-29: BillingTab (CreateInvoiceModal, row actions), api/invoices (create),
// api/invoices/[id]/send, lib/documents/send-invoice.ts, portal invoice page.

import type { HelpArticle } from '../types'

export const createAnInvoice: HelpArticle = {
  slug: 'create-an-invoice',
  title: 'Creating an invoice from a milestone, the SOW or a change order',
  summary: 'Pick what you are billing against, set the amount, tax and due date, then send it.',
  category: 'invoicing',
  order: 1,
  audience: { permissions: ['SEND_INVOICES'], plan: 'all' },
  shortAnswer:
    'Open the project\u2019s **Billing** tab, click **New invoice**, choose one thing to bill against (a milestone, a signed SOW or an accepted change order), fill in the amount, tax and due date, and click **Send**. ' +
    'Once sent, the invoice gets its permanent number and can no longer be edited.',
  beforeYouStart: [
    'A signed SOW. Milestones come from it, and a change order must be accepted before it can be billed.',
    'A client email address, and your own email verified.',
    'Payment instructions, either in the invoice or as the workspace default under Settings, plus a due date.',
  ],
  steps: [
    {
      title: 'Open the Billing tab and start a new invoice',
      body: 'On the project, open **Billing** and click **New invoice**. The window says \u201cBill against a milestone, a signed SOW, or an accepted change order.\u201d',
    },
    {
      title: 'Choose what you are billing against',
      body: 'Under **Bill against**, pick exactly one.',
      details: [
        'A **milestone** shows its amount. Pick it to bill that instalment.',
        'A **signed SOW** shows how much is still remaining to bill. An open-ended retainer shows \u201cno cap\u201d.',
        'An **accepted change order** is billed up to its accepted amount. A credit change order cannot be invoiced, because it reduces the contract.',
      ],
      watchFor: 'A milestone can only have one live invoice. A draft counts. Void or delete the first one before creating another.',
    },
    {
      title: 'Fill in the invoice',
      body: 'Enter a **Title**, then either an **Amount** or click **Itemize this invoice** to add line items. Set **Tax rate (%)**, **Due date**, an optional PO number, and the payment instructions.',
      details: [
        'You can click **Draft with AI** and describe what the invoice covers. It writes the lines but never the prices, so enter those yourself.',
        'The tax rate, the tax basis and the due date start from your SOW and workspace defaults.',
        'See the article \u201cTax-inclusive or tax-exclusive\u201d before you change the tax basis.',
      ],
    },
    {
      title: 'Create it, then check it',
      body: 'Click the create button. The invoice appears as a **Draft**. Use **Preview PDF** to see exactly what the client will get, and **Edit** to change anything.',
    },
    {
      title: 'Send it',
      body: 'Click **Send**. Confirm the prompt: the invoice is given its permanent number, emailed with a PDF, and locked.',
      details: [
        'A **Due date** and payment instructions are required.',
        'The due date cannot be in the past, and cannot be later than the payment terms in the SOW allow.',
        'If an approval rule applies, you see **Awaiting approval**, and **Retry send** if the send failed after approval.',
      ],
    },
    {
      title: 'What the client sees',
      body: 'The client gets an email with a link and the PDF. The page shows the invoice with **Download PDF**, an **I\u2019ve already paid this** button and a **Question about this invoice?** button.',
    },
  ],
  dos: [
    'Bill each milestone from its own invoice.',
    'Preview the PDF before sending.',
    'Put a PO number on the invoice if the client asked for one.',
    'Set a due date that matches the SOW payment terms.',
  ],
  donts: [
    'Do not try to edit a sent invoice. Void it and raise a new one if it is wrong.',
    'Do not invoice the SOW and its milestones both for the same money. ScopeGov warns you, but you can click past it.',
    'Do not send without checking the client\u2019s email address.',
    'Do not use a credit change order as the source of an invoice.',
  ],
  problems: [
    {
      symptom: '\u201cAn invoice must bill against exactly one of a milestone, SOW, or change order\u201d',
      meaning: 'None or more than one source was chosen.',
      fix: 'Choose one entry under **Bill against**.',
    },
    {
      symptom: '\u201cThis milestone already has an invoice\u201d',
      meaning: 'A draft or sent invoice already bills it.',
      fix: 'Edit or delete that one, or void it, before creating another.',
    },
    {
      symptom: '\u201cInvoice amount \u2026 exceeds this milestone\u2019s defined amount\u201d (or the change order\u2019s accepted amount, or the SOW\u2019s contract value)',
      meaning: 'The amount, before tax, is more than what is left to bill on that source.',
      fix: 'Lower the amount. If the milestone value really changed, adjust the milestone first.',
    },
    {
      symptom: '\u201cOnly a signed SOW can be invoiced against\u201d or \u201cOnly an accepted change order\u201d',
      meaning: 'The source is not signed or accepted yet.',
      fix: 'Wait for the client to sign or accept it.',
    },
    {
      symptom: '\u201cAdd a due date before sending this invoice\u201d or \u201cAdd payment instructions\u201d',
      meaning: 'A required field is empty.',
      fix: 'Click **Edit**, fill it in and send again.',
    },
    {
      symptom: '\u201cThe due date has already passed\u201d',
      meaning: 'An invoice cannot be sent with a past due date.',
      fix: 'Set a current due date.',
    },
    {
      symptom: '\u201cPlease verify your email before sending invoices\u201d',
      meaning: 'Your own email address is not verified.',
      fix: 'Verify it from the email we sent you.',
    },
  ],
  whatHappensNext: [
    'The invoice shows **Awaiting payment** until money is recorded against it.',
    'If the due date passes with a balance, it becomes **Overdue** and your team is notified.',
    'You record payments yourself, since ScopeGov does not collect money. See \u201cRecording partial payments\u201d.',
  ],
  related: ['payments-and-over-contract', 'tax-inclusive-or-exclusive', 'invoice-statuses'],
  updated: '2026-10-29',
}
