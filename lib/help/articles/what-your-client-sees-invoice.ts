// lib/help/articles/what-your-client-sees-invoice.ts
// Checked against the product code on 2026-10-29: app/portal/invoice/[token]/page.tsx (status badge, line items, balance, payment instructions, late fee,
// payment terms, payments received, contract position, "I've already paid this", "Question about this invoice?", banners), lib/email/templates.ts
// (subjects). The page has no card-payment button; clients pay using the instructions on it. If that changes, rewrite step 3.

import type { HelpArticle } from '../types'

export const whatYourClientSeesInvoice: HelpArticle = {
  slug: 'what-your-client-sees-invoice',
  title: 'What does my client see when they open my invoice, and how do they pay?',
  summary: 'See the invoice page as your client does, what they can tell you from it, and how a payment claim or a question reaches you.',
  category: 'invoicing',
  order: 6,
  audience: { permissions: ['SEND_INVOICES'], plan: 'all' },
  shortAnswer:
    'Your client opens a page with no login that shows the invoice, your payment instructions, the payments you have recorded and the contract position. ' +
    'There is no card button: they pay by the instructions you gave. They can tell you they have paid, ask a question about the invoice, and download a PDF.',
  steps: [
    {
      title: 'The email',
      body: 'The subject reads \u201cInvoice [number]: [title] \u2014 [project]\u201d (the number appears once the invoice has one). Reminders read \u201cReminder\u201d, \u201cDue soon\u201d or \u201cOverdue\u201d, then \u201cInvoice [number] \u2014 [project]\u201d.',
    },
    {
      title: 'The top of the page',
      body: 'The header shows your logo or agency name, the invoice title, the amount and **Due [date]**. A badge shows the status:',
      details: [
        '**Awaiting payment**, **Partially paid**, **Paid in full** or **Overdue**.',
      ],
    },
    {
      title: 'The money, in order',
      body: 'Below the header the client reads:',
      details: [
        'The line items, with **Description**, **Rate** and **Amount**, then **Subtotal** and tax.',
        '**Invoice amount**, **Paid to date** and **Balance due**. When nothing is owed it says **Paid in full**.',
        '**Payment instructions**: the text you wrote on the invoice or as your workspace default.',
        'A late fee note if one applies: \u201cOverdue amounts accrue a late fee of X% per month\u2026\u201d, and the SOW number if there is one.',
        '**Payment terms**, **Payments received** (date, method and reference for each payment you recorded) and **Contract position**.',
      ],
      watchFor: '**Contract position** shows contracted value, invoiced to date, paid to date and remaining to invoice, plus approved change orders not yet invoiced. Your client sees these totals.',
    },
    {
      title: 'How they pay',
      body: 'There is no card or online payment button on the page. The client pays using your **Payment instructions**, for example a bank transfer, and then you record the payment.',
      details: [
        'They can click **Download PDF** to keep or forward it.',
        'Payment instructions are required before you can send, so they always see something.',
      ],
    },
    {
      title: 'Telling you they have paid',
      body: 'Unless the invoice is paid, the client can click **I\u2019ve already paid this**, add an optional payment reference and a note, then click **Let the agency know**.',
      details: [
        'They then see \u201cYou told us you paid on [date]\u2026 the agency will confirm once it arrives.\u201d',
        'This is a claim, not a payment. The balance does not change until you record the payment.',
      ],
    },
    {
      title: 'Asking a question',
      body: 'They click **Question about this invoice?**, describe the issue (at least 10 characters), and send it. The invoice is then flagged for you.',
      details: [
        'They see \u201cYou flagged this on [date]\u201d, and the button becomes **Still have a question?**',
        'When you resolve it, they see \u201cYour question was marked resolved on [date].\u201d',
      ],
    },
  ],
  dos: [
    'Write Payment instructions the client can follow without asking you.',
    'Record payments promptly so Paid to date and the balance are right.',
    'Check Contract position before sending, because the client reads it.',
    'Reply to a question or claim quickly. The client can see it is open.',
  ],
  donts: [
    'Do not tell clients to \u201cpay on the invoice page\u201d. There is no button for that.',
    'Do not treat a payment claim as money received. Confirm it first.',
    'Do not leave a flagged question unresolved. The client sees it as open.',
    'Do not put anything in Payment instructions you would not want the client to forward.',
  ],
  problems: [
    {
      symptom: 'The client asks where to click to pay',
      meaning: 'The page has no online payment button.',
      fix: 'Point them to **Payment instructions** on the page, and make sure they are complete.',
    },
    {
      symptom: 'The client says they paid but the invoice still shows **Awaiting payment**',
      meaning: 'Their claim does not change the balance. You record payments.',
      fix: 'Check your bank, then record the payment on the invoice. See \u201cWhat do the invoice statuses mean?\u201d.',
    },
    {
      symptom: 'The client says the amounts do not match what we discussed',
      meaning: 'They used **Question about this invoice?**, so the invoice is flagged.',
      fix: 'Read their note, correct the invoice if needed, and mark the question resolved.',
    },
    {
      symptom: 'The client sees a balance that looks different from their records',
      meaning: 'The page shows what you have recorded, tax treatment included.',
      fix: 'Check **Payments received** and the tax lines, and record any payment you have missed.',
    },
  ],
  whatHappensNext: [
    'A payment claim or a question reaches you as a notification, and shows on the invoice.',
    'Recording a payment updates the balance and the status the client sees straight away.',
    'Overdue invoices show the **Overdue** badge, and the late fee note if you set a rate.',
  ],
  related: ['create-an-invoice', 'invoice-statuses', 'payments-and-over-contract', 'tax-inclusive-or-exclusive'],
  updated: '2026-10-29',
}
