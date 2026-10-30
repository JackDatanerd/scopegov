// lib/help/articles/what-your-client-sees-co.ts
// Checked against the product code on 2026-10-29: app/portal/co/[token]/page.tsx (header, sections, the three choices, accept/counter/decline forms,
// every dead-end state), app/api/portal/co/[token]/_actions.ts (confirmation messages, counter validation, credit COs cannot be countered),
// lib/email/templates.ts (subject and button text). If the portal copy changes, update the quoted messages below.

import type { HelpArticle } from '../types'

export const whatYourClientSeesCo: HelpArticle = {
  slug: 'what-your-client-sees-co',
  title: 'What does my client see when they open my change order, and what can they do?',
  summary: 'Walk through the client\u2019s email, page and three choices, and the messages they get if a link is expired or the change order has moved on.',
  category: 'change-orders',
  order: 6,
  audience: { permissions: ['SEND_CHANGE_ORDERS'], plan: 'all' },
  shortAnswer:
    'Your client gets an email with a link to a page with no login. The page shows your title, context, line items and impact, with three choices: **Accept**, **Propose counter** or **Decline**. ' +
    'A credit change order has no counter option. If the link is expired, withdrawn or already answered, the client sees a plain message saying so.',
  steps: [
    {
      title: 'The email',
      body: 'The subject reads \u201cChange order: [title] \u2014 [project]\u201d. The button says **Review & respond to change order \u2192**, or **Review & respond to credit change order \u2192** for a credit.',
    },
    {
      title: 'The top of the page',
      body: 'No login. The header shows **Change Order \u00b7 v[number]**, your title, \u201c[agency] \u2192 [client] \u00b7 [project]\u201d, and the total labelled **Additional scope cost**.',
      details: [
        'A **Download a copy to review (PDF)** link lets them read it offline.',
        'Near the choices they see the date the link expires.',
      ],
    },
    {
      title: 'The body',
      body: 'Below the header the client reads, in order:',
      details: [
        '**Context**: your explanation of why the change is needed.',
        '**Scope additions**: a table of **Description**, **Rate** and **Total**, then tax and the total.',
        '**Impact analysis**: the **Scope** and **Timeline** notes you wrote, and for a retainer renewal, how many months it extends the term.',
        'A credit change order shows the scope removed and the credit instead.',
      ],
      watchFor: 'Everything here is what you typed, so reread it on screen before you send. The client reads exactly this.',
    },
    {
      title: 'The three choices',
      body: 'A card headed **How would you like to respond?** offers **Accept**, **Propose counter** and **Decline**.',
      details: [
        'On a credit change order there is no **Propose counter**. If someone tries anyway, they see \u201cA credit change order can be accepted or declined, not countered.\u201d',
        'A change order the agency left unanswered for 5 days is still open to the client. Stalled is only a flag on your side.',
      ],
    },
    {
      title: 'If they accept',
      body: 'They type their full name, can add their title and \u201cSigning on behalf of\u201d, draw their signature, and click **Accept as [name]**.',
      details: [
        'If you signed first, they see your signature beside theirs.',
        'They then see \u201cThank you, [name]. The change order has been accepted. [agency] has been notified.\u201d',
        'The page then shows **Already accepted**, their signature and **Download PDF** whenever they return.',
      ],
    },
    {
      title: 'If they counter',
      body: 'They enter a **Counter amount** and a **Note**. The amount must be above zero. They see \u201cYour counter offer has been submitted. The agency will review and respond.\u201d',
      details: [
        'Afterwards the link shows **Counter already sent** until you respond.',
        'If you accept their amount, the same link now shows **Confirm change order**, with your acceptance. They sign again, and see \u201cThank you, [name]. The change order is confirmed.\u201d',
      ],
    },
    {
      title: 'If they decline',
      body: 'They can add an optional reason, then confirm. They see \u201cYou have declined this change order. The agency has been notified.\u201d',
    },
    {
      title: 'The messages they see instead',
      body: 'If the link cannot be answered, the client sees one of these:',
      details: [
        '**Link not found**: the link is wrong or has expired.',
        '**Link expired** or **Link deactivated**: ask the agency for a new one.',
        '**CO withdrawn** or **No longer available**: you withdrew or closed it.',
        '**Already accepted**, or **Counter already sent**: they have already answered.',
        '**No charge for this one**: you granted an exception, so there is nothing to sign.',
      ],
    },
  ],
  dos: [
    'Read the page as your client will before you send, including the Impact analysis.',
    'Write the Context for someone who was not in the call.',
    'Tell the client to expect the email, and what you need from them.',
    'Use a revised version if the link has expired, so they get a fresh link.',
  ],
  donts: [
    'Do not expect a client to find a counter on a credit change order. It does not exist.',
    'Do not edit the amount in an email thread. Revise the change order so the page matches.',
    'Do not assume stalled means the client cannot respond. They still can.',
    'Do not send a change order with an empty Context. The client has nothing to judge.',
  ],
  problems: [
    {
      symptom: 'The client says the link says it has expired',
      meaning: 'The change order\u2019s expiry date has passed.',
      fix: 'Revise the change order and send it again. The new version has a fresh link.',
    },
    {
      symptom: 'The client wants to counter a credit',
      meaning: 'A credit change order can only be accepted or declined.',
      fix: 'Ask them to decline it, then send a revised credit change order with the amount you agree.',
    },
    {
      symptom: 'The client says the page shows \u201cNo charge for this one\u201d',
      meaning: 'You granted an exception, so the change order closed at no cost.',
      fix: 'Nothing to do. If that was a mistake, raise a new change order.',
    },
    {
      symptom: 'The client says they already answered but sees the page again',
      meaning: 'They may be opening an older version\u2019s link.',
      fix: 'Send them the latest link from the project\u2019s **Change Orders** tab.',
    },
  ],
  whatHappensNext: [
    'An accepted change order is added to the contract value, and you are notified.',
    'A counter lands in your queue. See \u201cWhat do I do when a client counters my change order?\u201d.',
    'A declined change order stays on the project, with any reason the client gave.',
  ],
  related: ['create-and-send-co', 'client-counters-co', 'retainer-renewal-co', 'what-your-client-sees-sow'],
  updated: '2026-10-29',
}
