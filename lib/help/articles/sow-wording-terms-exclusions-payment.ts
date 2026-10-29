// lib/help/articles/sow-wording-terms-exclusions-payment.ts
//
// Traced to the code on 2026-10-29: lib/ai/sow-content.ts (boilerplate, prompt rules, ensureChangeOrderClause,
// retainerPaymentTermsHtml, fixedFeePaymentTermsHtml), lib/documents/defined-terms.ts, lib/documents/payment-terms.ts,
// lib/sow/validate-send.ts, lib/sow/table-schema.ts, components/sow/SowEditor.tsx (schedule totals).
// Re-check the warning texts if validate-send.ts changes.

import type { HelpArticle } from '../types'

export const sowWordingTermsExclusionsPayment: HelpArticle = {
  slug: 'sow-wording-terms-exclusions-payment',
  title: 'How do I word defined terms, exclusions and payment terms in a SOW?',
  summary: 'Write the parts of a SOW that cause disputes later so they are specific, consistent, and agree with the numbers in ScopeGov.',
  category: 'sow',
  order: 3,
  audience: { permissions: ['EDIT_SOW'], plan: 'all' },
  shortAnswer:
    'Use the three terms ScopeGov defines for you (SOW, Provider, Client) and do not invent others. Write exclusions as specific items, one per line. ' +
    'Make the Payment Terms agree with the project: same amount, same tax, same late fee, and a payment period written as a number of calendar days. ' +
    'If you use milestones, the Payment Schedule must add up to the contract value to the cent.',
  beforeYouStart: [
    'A drafted SOW, still a **Draft**. Wording cannot be changed after it is sent.',
    'The agreed price, currency, tax treatment and payment period for this client.',
  ],
  steps: [
    {
      title: 'Use the three defined terms, and no others',
      body: 'The **Parties** section defines \u201cSOW\u201d, \u201cProvider\u201d (your agency) and \u201cClient\u201d. Refer to the two sides only as Provider and Client, everywhere.',
      details: [
        'Do not switch to \u201cAgency\u201d, \u201cCustomer\u201d, \u201cCompany\u201d or \u201cVendor\u201d in other sections. A reader will wonder whether they are different people.',
        'Write \u201cthe services\u201d in lower case. A capitalised \u201cServices\u201d only works if a section actually defines it, for example (the \u201cServices\u201d).',
        'The drafter turns an undefined \u201cthe Services\u201d into lower case when it generates. Text you type yourself is not corrected, so check it.',
        'Name the Client by its legal name. If a company signs, fill in **Contracting company** when you generate, so the **Parties** section names the company and the person who signs for it.',
      ],
      watchFor: '**Parties**, **Governing Law** and **Signatures** are fixed wording. You can edit them, but they cannot be empty or hidden.',
    },
    {
      title: 'Name each deliverable once and reuse the name',
      body: 'Give every deliverable one clear name in the **Deliverables** table, then use that exact name in the Timeline, the Payment Schedule and **Out of Scope**.',
      details: [
        'Each row has **Deliverable**, **Acceptance Criteria**, **Owner** and **Target Date**. Say how the client will know it is done.',
        'If your brief lists an item that has no row of its own, the send check warns you, because the signed table would not state a promise you made.',
      ],
    },
    {
      title: 'Write exclusions as specific items',
      body: 'In **Out of Scope**, list things, not categories. One item per line, in plain words.',
      details: [
        'Specific: \u201cTranslation into languages other than English\u201d. Vague: \u201cAnything extra\u201d.',
        'Include what clients commonly assume is included: extra revision rounds, hosting, ad spend, stock licences, ongoing maintenance.',
        'If nothing is excluded, write \u201cNone\u201d. An empty section blocks the send.',
        'If your text does not already mention change orders, ScopeGov adds one sentence: any of these items may be performed only under a written change order signed by both parties.',
        'Exclusions you repeat on every project belong in Settings, under **Standard exclusions**, so each new draft starts with them.',
      ],
      watchFor: 'This list is what Guardian later measures client requests against. A missing exclusion is a request Guardian cannot flag.',
    },
    {
      title: 'State revisions and review time',
      body: 'In **Revision Policy**, say how many rounds are included and how they are counted.',
      details: [
        'Set **Client review window** in Settings so every SOW states how many business days the client has to approve or request changes.',
        'If the Revision Policy still says the period is \u201cagreed in writing before work begins\u201d, the send check warns you that a term is unresolved.',
      ],
    },
    {
      title: 'Make the Payment Terms agree with the project',
      body: 'Payment Terms is plain text, but ScopeGov checks it against the numbers it holds. Match them.',
      details: [
        'Amount: state the contract value in digits, for example \u201cUSD 12,500.00\u201d. For a retainer, it is the monthly fee, and the text should say \u201cper month\u201d.',
        'Tax: if the project carries a tax rate, write the rate with the percent sign, for example \u201c8.25%\u201d, and say whether it is included or added on top.',
        'Late fee: if your Settings set a late fee, write it with the percent sign. It is a stated term only. ScopeGov does not add the fee to invoices for you.',
        'Payment period: write it as \u201ceach invoice is due within 14 days of its invoice date\u201d or \u201cnet 30\u201d. A business-day period cannot be carried onto invoices and change orders, so use calendar days.',
        'The payment period is read from your final text when you send. Invoices and change orders under this SOW then use it.',
      ],
      watchFor: 'If you change the contract value on the project after drafting, the old figure is still in the text. Update the text, or regenerate it.',
    },
    {
      title: 'Build a Payment Schedule that adds up',
      body: 'Only for the **Milestones** structure. In **Payment Schedule**, add one row per payment with **Milestone**, **Amount** and **Trigger / Due**.',
      details: [
        'Put one plain number in **Amount**. Words or a second number in the cell, such as \u201cPhase 1 5000\u201d, make it unreadable.',
        'The editor shows **Schedule total**, **Contract value** and **Matches the contract value**. Otherwise it shows \u201cUnder by\u201d or \u201cOver by\u201d with the difference.',
        'It has to match to the cent. A row with a negative amount, such as a discount, still counts. A row with no milestone name is ignored.',
        'The **Payment Schedule** must stay visible. Make **Trigger / Due** a real event or date, such as \u201cOn approval of homepage design\u201d or \u201c1 March 2027\u201d.',
        'For every other payment structure, the schedule is worked out from the structure for display, and nothing needs to add up.',
      ],
    },
    {
      title: 'Read it as the client, then preview',
      body: 'Click **Preview PDF** and read the whole document once for contradictions between sections. The client signs this text, and nothing in it can be changed after you send.',
    },
  ],
  dos: [
    'State amounts, rates and days as numbers, so ScopeGov can check them against the project.',
    'Keep one name for each deliverable across every section.',
    'Say what happens to excluded items: they need a change order.',
    'Write \u201cNone\u201d in **Out of Scope** rather than leaving it empty, if truly nothing is excluded.',
  ],
  donts: [
    'Do not introduce new capitalised terms without defining them.',
    'Do not leave \u201cTo be confirmed\u201d or \u201c[insert date]\u201d in the text. The send check flags it as placeholder wording.',
    'Do not put business days in the payment period if you want invoices to follow it.',
    'Do not edit the Payment Schedule to make it add up to a different price than the project. Fix the price on the project.',
  ],
  problems: [
    {
      symptom: 'Warning: \u201cThe Payment Terms text does not state the contract value\u201d',
      meaning: 'No figure in that section equals the project\u2019s contract value. A percentage or a day count such as \u201c30 days\u201d does not count as an amount.',
      fix: 'Write the contract value in digits in **Payment Terms**, or click **Go back and fix** and update the text if the price changed.',
    },
    {
      symptom: 'Warning: \u201cInvoices will add 8.25% tax on top of the fee, but the Payment Terms text never mentions it\u201d',
      meaning: 'The project carries a tax rate that the text does not state.',
      fix: 'Add a sentence with the rate and whether it is included or added on top. Write the percent sign.',
    },
    {
      symptom: 'Warning: \u201cInvoices and change orders will quote a late fee, but the Payment Terms text never states it\u201d',
      meaning: 'A late fee is set in Settings, and the text does not say so.',
      fix: 'State the rate, for example \u201c1.5% per month\u201d, or change the late fee in Settings before drafting your next SOW.',
    },
    {
      symptom: '\u201cCouldn\u2019t read the amount on the Payment Schedule milestone\u201d',
      meaning: 'That row\u2019s **Amount** has no number, or more than one.',
      fix: 'Replace the cell with one plain number, such as 2500 or 2,500.00.',
    },
    {
      symptom: '\u201cThe Payment Schedule totals X but the contract value is Y\u201d',
      meaning: 'The milestone amounts do not add up to the contract value.',
      fix: 'Adjust the rows until the editor says **Matches the contract value**. If the price itself is wrong, change it on the project.',
    },
    {
      symptom: 'Warning: a section \u201cstill contains placeholder wording\u201d',
      meaning: 'A phrase such as \u201cTo be confirmed\u201d, TBC or \u201c[insert date]\u201d is still in the text.',
      fix: 'Replace it with the real term. Accept the warning only if you mean it, because the signed SOW will carry it.',
    },
  ],
  whatHappensNext: [
    'When you send, the text becomes the contract. It is locked, and the payment period it states is carried onto invoices and change orders.',
    'When your client signs, the payment milestones on the **Billing** tab are created: from your **Payment Schedule** rows for milestone payments, or from the payment structure you chose.',
    'Anything the SOW excludes comes back to you as a Guardian flag when the client asks for it, and a change order is how it gets added.',
  ],
  related: ['write-a-sow-ai-or-manual', 'review-sow-before-sending', 'why-cant-i-send-sow', 'when-to-write-a-co'],
  updated: '2026-10-29',
}
