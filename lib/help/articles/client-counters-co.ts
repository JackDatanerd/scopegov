// lib/help/articles/client-counters-co.ts
// Checked against the product code on 2026-10-29: portal/co/[token]/_actions.ts (POST_COUNTER), api/co/[id]/accept-counter,
// lib/documents/accept-co-counter.ts, api/co/[id]/revise, close, withdraw, ProjectDetail CoCard.

import type { HelpArticle } from '../types'

export const clientCountersCo: HelpArticle = {
  slug: 'client-counters-co',
  title: 'What happens when the client counters a change order',
  summary: 'The client proposes a different price. Here is what you can do, and what each choice does to the client.',
  category: 'change-orders',
  order: 3,
  audience: { permissions: ['SEND_CHANGE_ORDERS'], plan: 'all' },
  shortAnswer:
    'When a client clicks **Propose counter**, the change order moves to **countered** and the people who can send change orders are notified. ' +
    'You can **Accept counter** (the client then countersigns the new amount), **Revise & resend** with a new version, or **Close** it. Nothing binds either side until the client signs.',
  beforeYouStart: [
    'The Send Change Orders permission to accept or close, and Create Change Orders as well to revise.',
    'Your own email verified. Accepting a counter sends the client an email.',
  ],
  steps: [
    {
      title: 'See the counter',
      body: 'You get a bell notification and an email titled \u201cCounter offer\u201d. On the project\u2019s **Change orders** tab the card shows the status as countered with the client\u2019s **Counter amount** and note.',
      details: [
        'The client enters an amount and an optional note of up to 2,000 characters. They cannot counter a credit.',
        'Only the amount changes. The client cannot edit lines or the impact analysis.',
      ],
    },
    {
      title: 'Choose your response',
      body: 'Pick one of the three. Each is a button on the change order\u2019s card.',
      details: [
        '**Accept counter**: you agree to the client\u2019s amount.',
        '**Revise & resend**: you want a different outcome, such as the lower price with less scope.',
        '**Close**: you end the negotiation without a deal.',
        '**Exception** is available if you want to give the work away instead.',
      ],
    },
    {
      title: 'If you accept the counter',
      body: 'Click **Accept counter**. The price lines are rescaled to the client\u2019s amount and the client is emailed a new link to countersign. The change order is locked as **awaiting countersignature**.',
      details: [
        'The new link is valid for 30 days. The earlier link stops working.',
        'Use **Remind** if they have not countersigned, or **Withdraw** to pull it back.',
        'If your workspace has an approval rule for this amount, you see \u201cSent for approval\u201d and the client is emailed once it clears.',
      ],
      watchFor: 'Accepting changes the price lines only. It does not change the scope impact or timeline text, so if the lower price should mean less work, revise instead.',
    },
    {
      title: 'If you revise instead',
      body: 'Click **Revise & resend**. ScopeGov closes the countered version as superseded, creates a new draft version, and tells the client the earlier one is closed. Edit it and send as normal.',
      details: [
        'You need permission to both create and send change orders, because revising a countered change order notifies the client.',
        'Only one version can be live at a time.',
      ],
    },
    {
      title: 'If the client signs',
      body: 'On countersigning, the change order becomes accepted, a signed amendment is recorded, and the new deliverables are added to the scope.',
    },
  ],
  dos: [
    'Answer a counter promptly. The client is waiting.',
    'Compare the counter with what the work costs you before accepting.',
    'Revise when the price and the scope need to change together.',
    'Add a short reason when you close, withdraw or revise, so the client sees why.',
  ],
  donts: [
    'Do not assume the counter is accepted when you click **Accept counter**. The client still has to countersign.',
    'Do not accept a counter on a project that is Complete or Archived. It is refused until you reopen the project.',
    'Do not keep two versions open. Withdraw or close the old one first.',
    'Do not use **Close** to move on without telling anyone. The client is notified.',
  ],
  problems: [
    {
      symptom: 'I cannot see **Accept counter**',
      meaning: 'You lack permission to send change orders, or an approval request for this counter is already pending.',
      fix: 'Ask someone who has it, or open **Approvals** if it shows \u201cAwaiting approval\u201d.',
    },
    {
      symptom: '\u201cPlease verify your email before accepting a counter-offer\u201d',
      meaning: 'Your own email address is not verified.',
      fix: 'Verify it from the email we sent you, then try again.',
    },
    {
      symptom: '\u201cThis project is complete \u2014 a change order counter-offer can no longer be accepted\u201d',
      meaning: 'The project is finished.',
      fix: 'Reopen the project first. See the article 201cWhy can\u2019t I create a change order on a closed project?201d.',
    },
    {
      symptom: 'The client says the countersign link does not work',
      meaning: 'It has expired after 30 days, or you withdrew the change order.',
      fix: 'Revise and resend to issue a fresh link.',
    },
    {
      symptom: '\u201cThis counter-offer was just acted on by someone else\u201d',
      meaning: 'A colleague accepted, revised or closed it a moment ago.',
      fix: 'Refresh the project to see where it now stands.',
    },
  ],
  whatHappensNext: [
    'Accept counter: the client is emailed to countersign, and nothing is accepted until they do.',
    'Revise & resend: the old version closes and a new draft is created for you to edit.',
    'Close: the change order ends, the client is told, and you can still revise it later.',
    'Every step is recorded in the project\u2019s history and the audit log.',
  ],
  related: ['create-and-send-co', 'when-to-write-a-co'],
  updated: '2026-10-29',
}
