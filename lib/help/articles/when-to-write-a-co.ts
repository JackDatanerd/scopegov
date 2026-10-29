// lib/help/articles/when-to-write-a-co.ts
// Checked against the product code on 2026-10-29: ProjectDetail (flag actions, ExceptionModal, CoCard), api/co, api/guardian/flags,
// lib/documents/finalize-co.ts.

import type { HelpArticle } from '../types'

export const whenToWriteACo: HelpArticle = {
  slug: 'when-to-write-a-co',
  title: 'When to write a change order, and when to just absorb the work',
  summary: 'A simple way to decide, and how to give work away on purpose so it still leaves a record.',
  category: 'change-orders',
  order: 1,
  audience: { permissions: ['CREATE_CHANGE_ORDERS'], plan: 'all' },
  shortAnswer:
    'Write a change order when the request adds or removes deliverables, moves the delivery date, or costs you real time. Absorb it only when it is small and you choose to, and then record it with **Exception** so the free work is on file. ' +
    'A change order can only be written after the SOW is signed, on a project that is still active.',
  beforeYouStart: [
    'A project with a signed SOW that is Active or Stalled. Before that, there is nothing to change yet.',
    'The client\u2019s request in writing, or a Guardian flag that already captured it.',
  ],
  steps: [
    {
      title: 'Compare the request with the signed SOW',
      body: 'Open the project and read the deliverables, exclusions and revision rounds in the signed SOW. Ask one question: is this in there?',
      details: [
        'If it is in the SOW, it is not a change. Do it.',
        'If the project has Guardian switched on, an out-of-scope request may already be waiting as a flag on the **Guardian** tab.',
      ],
    },
    {
      title: 'Decide: charge, give, or decline',
      body: 'If it adds or removes deliverables, changes the date, or would take you more than a favour, write a change order. If it is small and you want to give it, record an exception. If you will not do it, say so.',
      details: [
        'Charge: **Draft CO** on the flag, or **New CO** on the **Change orders** tab.',
        'Give it away on purpose: **Exception** on the flag or on the change order.',
        'Take work out: tick **This is a credit / scope reduction** on a change order.',
      ],
    },
    {
      title: 'If you absorb it, record it',
      body: 'On the flag, click **Exception**. Fill in **What\u2019s being granted**, an optional **Estimated value** and a **Reason**, then click **Grant exception**. A reason is required.',
      details: [
        'It is the audit trail for scope granted without a change order. You can later show what you gave and why.',
        'It needs the permission to grant exceptions. People without it can click **Escalate** to hand the decision on.',
      ],
      watchFor: 'Quietly doing the work without an exception leaves no record, and the client learns that asking is free.',
    },
    {
      title: 'If it needs a change order, write it before you start the work',
      body: 'Do not begin the work and price it afterwards. Agree the price and the date first. See the article 201cCreating and sending a change order201d.',
    },
    {
      title: 'Let the accepted change order update the scope',
      body: 'When the client accepts, the new deliverables are added to the scope Guardian checks future requests against. A credit removes the items from it.',
    },
  ],
  dos: [
    'Check the signed SOW first, every time.',
    'Write the change order before the work starts.',
    'Use **Exception** for every freebie, however small.',
    'Put a real number on the **Estimated value** of what you give, so you can see the total later.',
  ],
  donts: [
    'Do not edit a signed SOW to fit the request. Use a change order.',
    'Do not absorb work because a change order feels awkward to send. Clients usually accept a clear, priced one.',
    'Do not use **Close** on a flag to make it go away. It closes the flag without recording a decision about the work.',
    'Do not bundle several unrelated requests into one change order if the client may want to accept only some of them.',
  ],
  problems: [
    {
      symptom: 'I cannot see **New CO** on the project',
      meaning: 'The project has no signed SOW yet, is not Active or Stalled, or you lack the permission to create change orders.',
      fix: 'See the article 201cWhy can\u2019t I create a change order on a closed project?201d.',
    },
    {
      symptom: 'The **Exception** button is missing on a flag',
      meaning: 'Granting exceptions is a separate permission.',
      fix: 'Click **Escalate** to pass the flag to someone who can, or ask an admin for the permission.',
    },
    {
      symptom: 'A flag is open and I am not sure the request is out of scope',
      meaning: 'Some flags are borderline and need a human decision.',
      fix: 'Click **Confirm out of scope** to treat it as a change, or **Dismiss** if it is in scope.',
    },
  ],
  whatHappensNext: [
    'A change order goes to the client by email and stays locked while you wait for an answer.',
    'An exception is recorded against the flag. No document goes to the client.',
    'Both appear in the project\u2019s history and the audit log.',
  ],
  related: ['create-and-send-co', 'first-project'],
  updated: '2026-10-29',
}
