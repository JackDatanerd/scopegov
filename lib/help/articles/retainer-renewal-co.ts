// lib/help/articles/retainer-renewal-co.ts
// Checked against the product code on 2026-10-29: CoEditor retainer controls, api/co (create), lib/documents/co-retainer.ts,
// renewal-term.ts, send-co.ts (renewalNeedsTerm), finalize-co.ts, portal CO page.

import type { HelpArticle } from '../types'

export const retainerRenewalCo: HelpArticle = {
  slug: 'retainer-renewal-co',
  title: 'Renewing a retainer or changing its monthly fee with a change order',
  summary: 'Extend a retainer, raise or lower the monthly fee, or add one-off work without touching the monthly rate.',
  category: 'change-orders',
  order: 4,
  audience: { permissions: ['CREATE_CHANGE_ORDERS', 'SEND_CHANGE_ORDERS'], plan: 'all' },
  shortAnswer:
    'On a retainer project, a change order can either bill a **One-time fee** or **Changes the monthly fee**. A renewal is the second kind: its total becomes the new monthly rate from acceptance, and on a fixed-term retainer you also say how many months it extends the term. ' +
    'The client signs it like any other change order.',
  beforeYouStart: [
    'A project of the retainer type with a signed SOW, Active or Stalled.',
    'The new monthly fee in full, not just the increase.',
    'For a fixed-term retainer: how many months you are extending it by.',
  ],
  steps: [
    {
      title: 'Start a change order on the retainer',
      body: 'Open the project, go to **Change orders** and click **New CO**.',
    },
    {
      title: 'Choose what it does',
      body: 'Under **What does this change order do?** pick one.',
      details: [
        '**One-time fee**: billed once, as its own invoice. The monthly retainer stays exactly as it is.',
        '**Changes the monthly fee**: extra monthly work, or a renewal. The total becomes the new monthly rate from acceptance.',
      ],
      watchFor: 'A credit cannot also be a renewal. The two options are mutually exclusive.',
    },
    {
      title: 'Price it as the new monthly fee',
      body: 'For a renewal, the first line is filled in as **Current monthly retainer (unchanged)**. Add what is new below it. The total is the new monthly rate, so the client sees the old rate inside the new one.',
      details: [
        'Check the tax setting matches how the SOW states the fee. It follows the SOW by default.',
      ],
    },
    {
      title: 'Set the term, if the retainer has an end date',
      body: 'On a fixed-term retainer, enter **Extends the retainer by** in whole months, from 1 to 120, counted from the current end date. It is required to send.',
      details: [
        'On an open-ended retainer there is no end date. The field does not appear, and accepting simply sets the new monthly rate.',
        'Timeline impact is not used on an open-ended retainer.',
      ],
    },
    {
      title: 'Send it',
      body: 'Click **Send to client**. See the article 201cCreating and sending a change order201d for the checks that apply.',
      details: [
        'The client sees **Retainer term**, \u201cAccepting this renewal extends the retainer by N months\u201d, and the monthly retainer rows in the impact analysis.',
      ],
    },
  ],
  dos: [
    'Enter the whole new monthly fee, with the current-rate line kept at the top.',
    'Send a renewal well before the term ends.',
    'Use **One-time fee** for extra work that should not change the monthly rate.',
    'Check the new rate and end date on the project after the client accepts.',
  ],
  donts: [
    'Do not enter only the increase as the total. The total becomes the whole monthly rate.',
    'Do not leave the term blank on a fixed-term retainer. The send is refused.',
    'Do not use a renewal on a non-retainer project. It is refused.',
    'Do not send a second renewal while the first is still live.',
  ],
  problems: [
    {
      symptom: '\u201cA retainer renewal needs its term\u201d',
      meaning: 'This retainer has an end date and **Extends the retainer by** is empty.',
      fix: 'Enter the number of months, then send.',
    },
    {
      symptom: '\u201cOnly a retainer project can have a retainer renewal change order\u201d',
      meaning: 'The project type is not retainer.',
      fix: 'Use a normal change order, or check the project type.',
    },
    {
      symptom: 'I cannot choose **Changes the monthly fee**',
      meaning: 'It is off while the change order is a credit, or locked after sending.',
      fix: 'Untick the credit box, or revise from the closed version.',
    },
    {
      symptom: 'The change order warns about a missing delivery date',
      meaning: 'It is one-time work on an open-ended retainer, so no date is stated.',
      fix: 'Add a **Delivery date**, or send as it is.',
    },
  ],
  whatHappensNext: [
    'On acceptance the monthly rate on the project is replaced with the new rate, and monthly billing uses it from then.',
    'A fixed-term retainer\u2019s end date moves out by the months you entered.',
    'A signed amendment is recorded and the renewal is logged in the audit log.',
    'If the client counters, see the article 201cWhat happens when the client counters201d.',
  ],
  related: ['create-and-send-co', 'client-counters-co'],
  updated: '2026-10-29',
}
