// lib/help/articles/payments-and-over-contract.ts
// Checked against the product code on 2026-10-29: api/invoices/[id]/payments (+ [paymentId]), api/invoices (create, over_contract),
// BillingTab (PaymentsPanel, RecordPaymentModal, MetricBlocks), app/(app)/invoices/page.tsx.

import type { HelpArticle } from '../types'

export const paymentsAndOverContract: HelpArticle = {
  slug: 'payments-and-over-contract',
  title: 'Recording partial payments, the payment ledger and \u201cover contract\u201d warnings',
  summary: 'Log money as it arrives, correct mistakes, and understand the warning when invoices add up to more than the contract.',
  category: 'invoicing',
  order: 2,
  audience: { permissions: ['SEND_INVOICES', 'VIEW_FINANCIALS'], plan: 'all' },
  shortAnswer:
    'ScopeGov does not collect money. When a payment reaches you, click **Record payment** on the invoice and log the amount, date and method. A part payment moves it to **Partially paid**, and the last one to **Paid**. ' +
    'The over-contract warning appears when your invoices would add up to more than the contracted value, and you can confirm and continue.',
  beforeYouStart: [
    'Permission to send invoices to record payments, and to view financials to see the ledger.',
    'The amount received, the date it arrived, and a reference such as a wire confirmation.',
  ],
  steps: [
    {
      title: 'Record a payment',
      body: 'On the project\u2019s **Billing** tab, click **Record payment** on a sent invoice. The window shows the balance due. Enter the **Amount**, **Date received**, the method and a reference, then click **Record payment**.',
      details: [
        'Methods are Bank transfer, Stripe, Check, Cash and Other.',
        'The date cannot be in the future. The reference can be up to 500 characters.',
        'You can only record payments on an invoice that is awaiting payment, partially paid or overdue.',
      ],
      watchFor: 'A payment cannot be larger than the balance remaining. Record what you actually received.',
    },
    {
      title: 'Record the next part payment',
      body: 'Do the same again for each part payment. The invoice shows **Partially paid** until the balance reaches zero, then **Paid**.',
    },
    {
      title: 'Correct a mistake in the ledger',
      body: 'Open the payments list on the invoice. Edit an entry and click **Save**, or remove it. Removing asks you to confirm and the balance updates immediately.',
      details: [
        'Payments on a draft or voided invoice cannot be edited.',
        'Payments on a voided invoice cannot be removed. They stay as the record of money received.',
      ],
    },
    {
      title: 'Read the ledger',
      body: 'The project\u2019s **Billing** tab shows **Contracted**, **Invoiced to date** and **Paid to date**, plus **At risk (pending COs)** when change orders are awaiting an answer. The workspace [Invoices](/invoices) page shows **Total invoices**, **Outstanding**, **Overdue** and **Collected**, with receivables aging below.',
      details: [
        'Contracted means the signed SOW plus accepted change orders.',
        'If the daily snapshot has not run for a project yet, the tab says it is showing live figures.',
      ],
    },
    {
      title: 'Understand the \u201cover contract\u201d warning',
      body: 'When you create or edit an invoice that would push the total invoiced (drafts included, before tax) above the contracted value, you see \u201cCreate this invoice anyway?\u201d or \u201cSave this change anyway?\u201d. Click **Create anyway** or **Save anyway** to continue, or cancel.',
      details: [
        'It is a confirmation, not a block. Reimbursables and time-and-materials overage can be legitimate.',
        'Each source has its own hard limit that you cannot click past: a milestone\u2019s amount, a change order\u2019s accepted amount, and the SOW\u2019s contract value.',
      ],
    },
  ],
  dos: [
    'Record each payment on the day you see it arrive.',
    'Put a bank reference in the reference field so you can match it later.',
    'Use the over-contract warning as a prompt to check for double billing.',
    'Compare **Paid to date** with your bank at month end.',
  ],
  donts: [
    'Do not record a payment you have not received. The client may be told it was paid.',
    'Do not click **Create anyway** without checking which invoices already cover the same work.',
    'Do not remove a payment to hide a refund. Record refunds outside ScopeGov and keep the invoice as the record.',
    'Do not edit amounts on a sent invoice to match what was paid. Record the actual payment.',
  ],
  problems: [
    {
      symptom: '\u201cPayment of X exceeds the remaining balance of Y\u201d',
      meaning: 'The amount is more than what is still owed.',
      fix: 'Enter the correct amount, or the balance if it is a final payment.',
    },
    {
      symptom: '\u201cThis payment would exceed the invoice balance \u2014 someone may have just recorded another payment\u201d',
      meaning: 'A colleague recorded a payment at the same moment.',
      fix: 'Refresh the page and check the ledger before trying again.',
    },
    {
      symptom: '\u201cPayments can only be recorded on a sent, unpaid invoice\u201d',
      meaning: 'The invoice is a draft, already paid or void.',
      fix: 'Send it first, or check its status.',
    },
    {
      symptom: '\u201cThis invoice was just voided, so a payment can no longer be recorded\u201d',
      meaning: 'Someone voided it a moment ago.',
      fix: 'Refresh to see its state.',
    },
    {
      symptom: 'The warning says the total invoiced is more than the contracted value',
      meaning: 'This and your other invoices, drafts included, exceed the SOW plus accepted change orders.',
      fix: 'Check for overlap, such as a SOW invoice and its milestones. If it is correct, click **Create anyway**.',
    },
  ],
  whatHappensNext: [
    'Your team is notified of each recorded payment, and the invoice moves to **Partially paid** or **Paid**.',
    'If the client had clicked **I\u2019ve already paid this**, recording a payment clears that claim.',
    'The project\u2019s **Paid to date** and the workspace **Collected** figure update.',
  ],
  related: ['create-an-invoice', 'invoice-statuses', 'export-invoices'],
  updated: '2026-10-29',
}
