// lib/help/articles/create-and-send-co.ts
// Checked against the product code on 2026-10-29: CoEditor, api/co (create, send), lib/documents/send-co.ts,
// co-input.ts, co-delivery.ts, co-definition.ts, portal CO page, cron/co-stall, co-expiry.

import type { HelpArticle } from '../types'

export const createAndSendCo: HelpArticle = {
  slug: 'create-and-send-co',
  title: 'Creating and sending a change order, with scope and timeline impact',
  summary: 'Write a change order the client can say yes to, and know what ScopeGov checks before it goes.',
  category: 'change-orders',
  order: 2,
  audience: { permissions: ['CREATE_CHANGE_ORDERS', 'SEND_CHANGE_ORDERS'], plan: 'all' },
  shortAnswer:
    'Open the project\u2019s **Change orders** tab, click **New CO**, describe the new work, add priced line items and state the scope and timeline impact, then click **Send to client**. ' +
    'The client gets a link where they can accept, propose a counter or decline. Pricing needs financial access.',
  beforeYouStart: [
    'A signed SOW, and a project that is Active or Stalled.',
    'A client email address on the project, and your own email verified.',
    'The price, any change to the delivery date, and what the new work does or does not include.',
  ],
  steps: [
    {
      title: 'Start the change order',
      body: 'On the project, open **Change orders** and click **New CO**. If you are acting on a Guardian flag, click **Draft CO** on the flag instead and its request text is carried over.',
      details: [
        'Click **Draft with AI**, describe what the client is asking for, and it drafts the title and lines. Check them before you rely on them.',
        'Tick **This is a credit / scope reduction** if you are taking work out. See below.',
      ],
    },
    {
      title: 'Describe the change',
      body: 'Fill in **Title** (required) and **Context note**, which is shown to the client.',
    },
    {
      title: 'State the impact',
      body: 'Fill in **Scope impact** and **Timeline impact**. They appear to the client under **Impact analysis**.',
      details: [
        '**Scope impact** is one or two sentences, for example what is added and where.',
        '**Timeline impact** is the net change in days, a whole number such as 18 or -5. A negative number pulls the date in.',
        '**Revised delivery date** is the new date, if the timeline moves.',
        'On an open-ended retainer there is no delivery date to move. The field becomes **Delivery date** for one-time work.',
      ],
      watchFor: 'If the new work includes deliverables, say whether it includes revisions. The SOW\u2019s revision policy was written for the original work.',
    },
    {
      title: 'Add the price',
      body: 'Add line items with a description, quantity and rate. Set the tax if it differs from the project. Choose **When is this invoiced?**: **Once the change order is accepted** or **Once the work is delivered**.',
      details: [
        'Every line with a value needs a description.',
        'The total must be above zero, or below zero for a credit.',
        'Without financial access you can describe the change but someone with it has to add the pricing.',
      ],
    },
    {
      title: 'Choose how long the link lasts and send',
      body: 'Set **Link valid for** (7, 14, 30, 60 or 90 days; 30 by default) and click **Send to client**. Click **Save draft** to come back later.',
      details: [
        'The client receives an email with a secure link.',
        'If your workspace has an approval rule for this amount, you see \u201cSent for approval\u201d and the client is emailed once it clears.',
      ],
    },
    {
      title: 'What the client sees',
      body: 'The client opens the link and sees your title, context, line items, the **Impact analysis**, and three choices: **Accept**, **Propose counter** or **Decline**. A credit can only be accepted or declined.',
    },
  ],
  dos: [
    'Say what is excluded as well as what is included.',
    'Give a delivery date when the work is one-time.',
    'Keep one change order to one decision.',
    'Use **Save draft** and review the preview before you send.',
  ],
  donts: [
    'Do not send without a scope impact line. It is the sentence the client reads first.',
    'Do not edit after sending. It is locked until the client answers, or you withdraw it.',
    'Do not send two versions at once. Only one version can be live.',
    'Do not rely on the AI draft for prices.',
  ],
  problems: [
    {
      symptom: '\u201cAdd at least one line item before sending this change order.\u201d',
      meaning: 'The draft has no usable lines.',
      fix: 'Add a line with a description and a value, then send.',
    },
    {
      symptom: '\u201cThis change order has no value\u201d',
      meaning: 'The total is zero or negative on a normal change order.',
      fix: 'Add amounts, or tick **This is a credit / scope reduction** if you mean to reduce the contract.',
    },
    {
      symptom: '\u201cThis project has no signed SOW yet\u201d',
      meaning: 'A change order amends a signed SOW.',
      fix: 'Get the SOW signed first.',
    },
    {
      symptom: 'The client has no email address',
      meaning: 'There is nowhere to send it.',
      fix: 'Add an email on the client record, then send.',
    },
    {
      symptom: '\u201cVersion N of this change order is still open\u201d',
      meaning: 'An earlier version is live. Only one can be.',
      fix: 'Withdraw or close the earlier version, then send.',
    },
    {
      symptom: 'A warning appears before sending (billing address, no delivery date, revisions not stated)',
      meaning: 'ScopeGov noticed something a client would likely ask about.',
      fix: 'Fix it, or send anyway if it is intentional.',
    },
    {
      symptom: 'The client has not answered',
      meaning: 'After 5 days of silence the change order is marked **stalled** and your team is told.',
      fix: 'Click **Remind** (it reads **Try again** when stalled). A link left unused past its expiry becomes expired.',
    },
  ],
  whatHappensNext: [
    'The change order is locked and its status is awaiting response.',
    'If the client accepts, it becomes part of the signed agreement, its deliverables join the scope Guardian checks, and it is invoiced as you chose.',
    'If they counter or decline, you are notified. See the article 201cWhat happens when the client counters201d.',
  ],
  related: ['when-to-write-a-co', 'client-counters-co', 'retainer-renewal-co'],
  updated: '2026-10-29',
}
