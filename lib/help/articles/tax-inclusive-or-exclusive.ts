// lib/help/articles/tax-inclusive-or-exclusive.ts
// Checked against the product code on 2026-10-29: BillingTab (Create/Edit invoice tax controls), lib/documents/invoice-totals.ts,
// tax-basis.ts, tax-defaults.ts, lib/pdf/renderer.tsx (invoice totals), portal invoice page, Settings > Workspace billing defaults.

import type { HelpArticle } from '../types'

export const taxInclusiveOrExclusive: HelpArticle = {
  slug: 'tax-inclusive-or-exclusive',
  title: 'Tax-inclusive or tax-exclusive: how to set it and what the client sees',
  summary: 'Decide whether the figure you type already contains tax, and see how it appears on the invoice.',
  category: 'invoicing',
  order: 3,
  audience: { permissions: ['SEND_INVOICES'], plan: 'all' },
  shortAnswer:
    'On an invoice, set **Tax rate (%)**, then **Amount entered above is**: **Before tax** means tax is added on top of your figure, and **Tax-inclusive** means your figure is what the client pays and the tax sits inside it. ' +
    'New invoices start from your SOW\u2019s tax terms, or your workspace default, so you rarely need to change it.',
  beforeYouStart: [
    'The tax rate that applies, and whether your SOW quoted prices with tax in or out.',
    'Permission to send invoices. Workspace defaults need permission to manage workspace settings.',
  ],
  steps: [
    {
      title: 'Set your workspace default once',
      body: 'Open [Settings](/settings), the **Workspace** tab, and the billing defaults. Set **Default tax rate (%)** and **Amounts entered are**, then click **Save changes**.',
      details: [
        'These apply to new projects and to invoices whose SOW states no tax.',
        'A SOW that states a tax rate takes priority. The latest signed one is used.',
      ],
    },
    {
      title: 'Check the invoice\u2019s tax settings',
      body: 'In **New invoice** or **Edit draft invoice**, look at **Tax rate (%)** and **Amount entered above is**. They are pre-filled; change them only if this invoice differs.',
      details: [
        '**Before tax**: you type the net amount. Tax is added, and the client owes the total.',
        '**Tax-inclusive**: you type the gross amount the client pays. The tax is worked out from it.',
        'At a rate of 0 there is no tax and the basis selector is disabled.',
      ],
    },
    {
      title: 'Itemized invoices are always before tax',
      body: 'If you click **Itemize this invoice**, the selector locks to **Before tax**. Line items are entered before tax, and tax is added on top of their total.',
    },
    {
      title: 'Check the result in the preview',
      body: 'Click **Preview PDF** on the draft. Compare the subtotal, tax and amount due with what you meant.',
      details: [
        'Example at 16%, entering 1,000. Before tax: subtotal 1,000.00, tax 160.00, amount due 1,160.00.',
        'Tax-inclusive: subtotal 862.07, tax included 137.93, amount due 1,000.00.',
      ],
    },
    {
      title: 'What the client sees',
      body: 'The PDF and the client page show the same split.',
      details: [
        'With tax added on top: **Subtotal**, **Tax (16%)** and **Amount due**.',
        'With tax included: the subtotal before tax, the tax marked as included, and the same **Amount due** you typed.',
        'With no tax, only **Amount due** is shown.',
      ],
    },
  ],
  dos: [
    'Match the basis to how the SOW quoted the price.',
    'Preview the PDF whenever you change the tax settings.',
    'Set the workspace default so every new invoice starts correct.',
    'Remember that contract caps and the over-contract check measure the amount before tax.',
  ],
  donts: [
    'Do not change the basis on a sent invoice. It is locked. Void and re-issue if it is wrong.',
    'Do not type a tax-inclusive figure while **Before tax** is selected. The client would pay tax twice.',
    'Do not expect the basis selector to work on an itemized invoice. It is fixed.',
    'Do not leave a tax rate on a zero-tax client by mistake. Set the rate to 0.',
  ],
  problems: [
    {
      symptom: '**Amount entered above is** is greyed out',
      meaning: 'The tax rate is 0, or the invoice is itemized.',
      fix: 'Enter a rate above 0 on a non-itemized invoice to choose.',
    },
    {
      symptom: '\u201cTax rate must be a number between 0 and 100\u201d',
      meaning: 'The rate is outside the allowed range.',
      fix: 'Enter a figure from 0 to 100.',
    },
    {
      symptom: 'The amount due is not what I typed',
      meaning: 'The basis is **Before tax**, so tax was added to your figure.',
      fix: 'Switch to **Tax-inclusive** if you typed the total.',
    },
    {
      symptom: 'The invoice shows no tax although the SOW had tax',
      meaning: 'The tax rate on the invoice is 0.',
      fix: 'Edit the draft and set the rate.',
    },
  ],
  whatHappensNext: [
    'The tax rate and basis are saved with the invoice and printed on the PDF.',
    'Once sent, they cannot change. Payments are recorded against the amount due.',
    'Your CSV export shows the subtotal, tax rate, tax amount and total as separate columns.',
  ],
  related: ['create-an-invoice', 'workspace-setup', 'export-invoices'],
  updated: '2026-10-29',
}
