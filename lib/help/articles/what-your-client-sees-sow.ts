// lib/help/articles/what-your-client-sees-sow.ts
//
// Traced to the code on 2026-10-29: app/portal/sow/[token]/page.tsx (every client-facing label below is copied from it),
// app/api/portal/sow/[token]/{route,sign,request-changes,decline}/route.ts, lib/email/templates.ts (sendSowEmail),
// lib/pdf/sow-watermark.ts, lib/documents/signer-title.ts. Re-check if the portal page changes.

import type { HelpArticle } from '../types'

export const whatYourClientSeesSow: HelpArticle = {
  slug: 'what-your-client-sees-sow',
  title: 'What does my client see when they open my SOW, and how do they sign?',
  summary: 'Walk through the email, the signing page and the signed copy exactly as your client meets them.',
  category: 'sow',
  order: 5,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Your client gets an email with a link. The link opens a page, with no account or password, that shows your SOW and three choices: **Sign agreement**, **Request changes** or **Decline**. ' +
    'Signing takes a typed name, a drawn signature and a tick box. The signed PDF is emailed to them straight away.',
  steps: [
    {
      title: 'The email',
      body: 'The client receives an email from your agency, in your brand colour, titled \u201cPlease review and sign your project agreement\u201d.',
      details: [
        'It shows the project name, the contract value (the monthly fee, for a retainer) and the date the link expires.',
        'It is copied to the client\u2019s extra email addresses and to their primary contact, if you set them up. Replies go to you.',
        'If you want to resend the link yourself, click **Copy signing link** on the **SOW** tab.',
      ],
    },
    {
      title: 'The top of the signing page',
      body: 'The page opens at the document, not a login. The header shows your logo or agency name.',
      details: [
        'Statement of Work and its version, the project name, and \u201cPrepared by\u201d your agency \u201cfor\u201d the client.',
        'Your **MSA reference**, if you entered one.',
        'The amount with its currency. A retainer shows \u201c/ mo\u201d, plus the number of months and the total, if the term is fixed.',
        '**Download a copy to review (PDF)**: an unsigned copy, marked **UNSIGNED**, that they can pass to a lawyer or finance.',
      ],
    },
    {
      title: 'The parties and the sections',
      body: 'Below the header, the client sees two boxes, then the agreement itself.',
      details: [
        'An **Agency (Service Provider)** box with your name, address, tax ID, phone and website, and a **Client** box with their company, contact name, billing address and VAT number. Missing details are left out.',
        'Every section you left visible, in order, in the SOW\u2019s language. Sections you hid are not sent to the client at all.',
        'A text section with nothing in it is left out. An empty table shows \u201cTo be defined\u201d.',
        'The **Parties** and **Signatures** wording appears without its heading, because the boxes above and the signing card below replace it.',
      ],
    },
    {
      title: 'The three choices',
      body: 'At the bottom is a card headed \u201cReady to proceed?\u201d, with the expiry date underneath.',
      details: [
        '**Sign agreement** opens the signing form.',
        '**Request changes** opens a box. They write what they want changed, at least 20 characters, and click **Send feedback**.',
        '**Decline** opens a box with an optional reason, and the button **Decline agreement**.',
      ],
    },
    {
      title: 'Signing',
      body: 'The signing form asks for the minimum a signature needs.',
      details: [
        '**Your full name**: required, at least three characters.',
        '**Position** and **Signing on behalf of**: both optional. If Position is blank and the person is the signer you named when drafting, your saved title for them is used.',
        '**Draw your signature**, with a **Clear** link to start again.',
        'If you saved an agency signature in Settings, a box shows \u201cAlready signed by\u201d your agency above the tick box.',
        'A tick box: \u201cI have read and agree to all the terms in this Statement of Work\u201d. Then the button **Sign as** their name.',
      ],
      watchFor: 'The agency\u2019s signature is the one you saved in [Settings](/settings) under **Branding**. Nobody on your side signs at this point, so add it before you send.',
    },
    {
      title: 'After they sign',
      body: 'The client sees **Agreement signed**, their signature, and **Download PDF**.',
      details: [
        'The signed PDF is emailed to them, and to your team members who receive signing notifications.',
        'Their link is replaced with one that lasts about two years. The original link keeps opening the signed document too.',
        'On your side: the SOW shows **Signed**, the project turns **Active**, Guardian gets its forwarding email address, the **Billing** tab gets its payment milestones, and the audit log records the signature.',
      ],
    },
  ],
  dos: [
    'Tell the client the email is coming, and from which address.',
    'Open **Preview PDF** first. The signing page shows the same text.',
    'Send the link only to the person who should sign.',
    'Set your agency signature and signatory name before you send.',
  ],
  donts: [
    'Do not post or forward the signing link where others can see it. Whoever holds it can sign as the client.',
    'Do not expect the client to create an account. There isn\u2019t one.',
    'Do not edit a SOW the client may be reading. Withdraw it first.',
    'Do not assume hidden sections or attachments reach the client. They do not.',
  ],
  problems: [
    {
      symptom: 'The client sees \u201cLink not found\u201d',
      meaning: 'The link is wrong or incomplete, often cut off when it was copied into a chat or email.',
      fix: 'Copy the link again with **Copy signing link** and send it in full.',
    },
    {
      symptom: 'The client sees \u201cLink expired\u201d',
      meaning: 'The 30-day signing window has passed.',
      fix: 'Click **Start new version** on the **SOW** tab and send it again. That creates a new link.',
    },
    {
      symptom: 'The client sees \u201cSOW withdrawn\u201d or \u201cLink deactivated\u201d',
      meaning: 'You withdrew the SOW, or the link was deactivated.',
      fix: 'Send the current version. If you have not started one, click **Start new version**.',
    },
    {
      symptom: 'The client sees \u201cChanges requested\u201d when they reopen the link',
      meaning: 'They already asked for changes on that version. It can no longer be signed.',
      fix: 'Send them the revised version when it is ready. It comes with a new link.',
    },
    {
      symptom: 'The client sees \u201cAgreement declined\u201d, \u201cAgreement signed\u201d or \u201cThis SOW was already signed\u201d',
      meaning: 'The link has already been used. Each SOW takes one answer.',
      fix: 'If they declined and want to continue, click **Start new version** and send again. If it is signed, nothing more is needed.',
    },
    {
      symptom: 'The client says Sign will not work',
      meaning: 'The form needs a name of at least three characters, a drawn signature and the tick box.',
      fix: 'Ask them to fill in all three. Messages on the form say which one is missing.',
    },
    {
      symptom: 'The client wants a copy before they sign',
      meaning: 'They want to review it offline.',
      fix: 'They can use **Download a copy to review (PDF)** on the signing page.',
    },
  ],
  whatHappensNext: [
    'If the client signs, they and your team are emailed the signed PDF, and the project goes **Active**.',
    'If they request changes or decline, you are told by email and in the app. See the article on changes, declines and silence.',
    'If they do nothing, the project is marked **Stalled** after 7 days and the link expires after 30.',
  ],
  related: ['review-sow-before-sending', 'client-changes-decline-or-silence-sow', 'withdraw-revise-resend-sow', 'first-project'],
  updated: '2026-10-29',
}
