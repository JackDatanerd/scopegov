// lib/help/articles/export-invoices.ts
// Checked against the product code on 2026-10-29: api/invoices/export, app/(app)/invoices/page.tsx, lib/billing/entitlements.ts.

import type { HelpArticle } from '../types'

export const exportInvoices: HelpArticle = {
  slug: 'export-invoices',
  title: 'Exporting your invoices to a spreadsheet',
  summary: 'Download every invoice, or a filtered set, as a CSV that opens in Excel or Google Sheets.',
  category: 'invoicing',
  order: 5,
  audience: { permissions: ['VIEW_FINANCIALS'], plan: 'all' },
  shortAnswer:
    'Open [Invoices](/invoices), narrow the list if you like, and click **Export CSV**. You get one row per invoice with its totals, tax, what has been paid, the balance and the dates. ' +
    'The export is available on every plan, and still works when a workspace is read-only.',
  beforeYouStart: [
    'Permission to view financials. The Invoices page is hidden from members who lack it.',
  ],
  steps: [
    {
      title: 'Open the Invoices page',
      body: 'Click **Invoices** in the sidebar. It lists invoices across all your projects, with **Total invoices**, **Outstanding**, **Overdue** and **Collected** at the top.',
    },
    {
      title: 'Filter what you want',
      body: 'Use the status filter and the search box (number, title, project or client), then click **Search**. **Clear** resets them.',
      details: [
        'The export uses the filter you have applied, so a filtered list gives a filtered file.',
        'A very broad text search can match too many projects. You are asked to make it more specific.',
      ],
    },
    {
      title: 'Click Export CSV',
      body: 'The file downloads as invoices-YYYY-MM-DD.csv, using the date in your workspace time zone.',
    },
    {
      title: 'Open it',
      body: 'Open the file in Excel, Numbers or Google Sheets. It is UTF-8 with a byte-order mark so accented names display correctly.',
      details: [
        'Columns: Invoice number, Title, Status, Project, Client, Currency, Subtotal, Tax rate %, Tax amount, Total, Paid, Balance due, Issued, Due, Paid on, Voided on, PO number, Disputed.',
        '**Balance due** is filled only for invoices awaiting payment, partially paid or overdue. Paid, void and draft rows show 0.',
        '**Disputed** says Yes while a client question is open.',
      ],
    },
  ],
  dos: [
    'Filter to one status for a clean receivables list.',
    'Match **Total** and **Paid** against your accounting system.',
    'Use the **Currency** column when you bill in more than one currency.',
    'Export at month end and keep the file with your books.',
  ],
  donts: [
    'Do not add up **Total** across currencies.',
    'Do not treat the export as a payment-by-payment ledger. It has one row per invoice, with the amount paid.',
    'Do not share the file widely. It lists clients and amounts.',
    'Do not expect draft totals to be final. They can still change.',
  ],
  problems: [
    {
      symptom: 'I cannot see **Export CSV**',
      meaning: 'You do not have permission to view financials, or your session is read-only for this feature.',
      fix: 'Ask an admin to grant View Financials.',
    },
    {
      symptom: '\u201cInvoice export is not included in your plan\u201d',
      meaning: 'Your plan does not include it.',
      fix: 'Check [Settings](/settings?tab=billing) for your plan.',
    },
    {
      symptom: '\u201cThat search matches too many projects to export reliably\u201d',
      meaning: 'The text search is too broad.',
      fix: 'Make it more specific, or filter by status instead.',
    },
    {
      symptom: 'The file shows odd characters in Excel',
      meaning: 'It was opened as plain text and not as UTF-8.',
      fix: 'Use Data \u2192 From Text/CSV and choose UTF-8.',
    },
  ],
  whatHappensNext: [
    'The export is recorded in your audit log with how many rows it held and the filter used.',
    'Nothing changes in ScopeGov. The file is a snapshot of the moment you downloaded it.',
  ],
  related: ['invoice-statuses', 'payments-and-over-contract'],
  updated: '2026-10-29',
}
