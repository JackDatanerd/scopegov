// lib/help/articles/review-sow-before-sending.ts
//
// Traced to the code on 2026-10-29: app/(app)/projects/[id]/sow/[sowId]/page.tsx, components/projects/ProjectDetail.tsx (SowTab),
// components/documents/ClientDetailsWarningModal.tsx, lib/documents/client-details-gap.ts, lib/sow/validate-send.ts,
// lib/documents/send-sow.ts, lib/email/templates.ts (sendSowEmail). The blockers themselves are covered in why-cant-i-send-sow;
// this article is the review you do BEFORE clicking, so keep the two consistent.

import type { HelpArticle } from '../types'

export const reviewSowBeforeSending: HelpArticle = {
  slug: 'review-sow-before-sending',
  title: 'What should I check before I send a SOW?',
  summary: 'A checklist to run on a draft before it goes to your client, and what the send checks will and will not catch.',
  category: 'sow',
  order: 4,
  audience: { permissions: ['SEND_SOW'], plan: 'all' },
  shortAnswer:
    'ScopeGov blocks a send when something required is missing, and warns you about a few things worth a second look. It cannot tell you whether the scope, the price or the wording is right. ' +
    'Read the SOW once as your client, check the money, the scope and the parties, then click **Send to client**. Once sent, it is locked.',
  beforeYouStart: [
    'A draft SOW on the project\u2019s **SOW** tab, with status **Draft**.',
    'Your own email address is verified. ScopeGov will not send a SOW from an unverified account.',
    'Permission to send SOWs. Without it there is no **Send to client** button. See the article \u201cWhy can\u2019t I send this SOW?\u201d if it is missing.',
  ],
  steps: [
    {
      title: 'Read the whole thing as your client',
      body: 'Open the SOW and click **Preview PDF**. Read it top to bottom as if you had never seen the project.',
      details: [
        'You only see **Preview PDF** if you are allowed to view financials.',
        'An unsent copy carries an **UNSIGNED** or **DRAFT** watermark. It disappears once the client signs.',
        'Look for contradictions between sections, not just typos.',
      ],
    },
    {
      title: 'Check the money',
      body: 'Compare the document with what you agreed.',
      details: [
        'Contract value and currency. For a retainer, the value is the monthly fee.',
        'The Payment Terms text and the **Payment Schedule**. They have to say the same thing.',
        'Tax: the rate, and whether it is included or added on top.',
        'The payment period, and the late fee if you charge one.',
      ],
      watchFor: 'If you changed the price after drafting, the old figure may still be in the Payment Terms text.',
    },
    {
      title: 'Check the scope',
      body: 'This is the part you will point back to later.',
      details: [
        '**Deliverables**: every promised item has a row, with acceptance criteria and an owner.',
        '**Out of Scope**: every exclusion you discussed is written down. Write \u201cNone\u201d if there are none.',
        '**Revision Policy**: the number of rounds, and the client\u2019s review time.',
        '**Timeline & Milestones** and **Assumptions & Dependencies** match what the client has been told.',
      ],
    },
    {
      title: 'Check who is agreeing',
      body: 'A signature is only as good as the names above it.',
      details: [
        '**Parties**: the client\u2019s legal name, and the person who signs for it if it is a company.',
        '**Governing Law** names a state or country, not just \u201cUnited States\u201d.',
        'Your agency\u2019s business address, signature and signatory name are saved in [Settings](/settings), under **Workspace** and **Branding**.',
        'The client\u2019s billing address is on the client\u2019s page in [Clients](/clients).',
      ],
    },
    {
      title: 'Check what the client will not see',
      body: 'Anything you hid, and anything stored outside the document text, stays with you.',
      details: [
        'Sections you hid with the eye button are left out of the document the client reads and signs.',
        'Files in the **Attachments** panel do not appear on the client\u2019s signing page or in the PDF.',
        'The **MSA reference** field, if filled in, prints at the top of the document.',
      ],
    },
    {
      title: 'Click Send to client',
      body: 'Use the button at the top of the editor or on the **SOW** tab. ScopeGov runs its checks and tells you the result.',
      details: [
        'A message names a blocker. Fix it and click again. The article \u201cWhy can\u2019t I send this SOW?\u201d lists them all.',
        'A **Send anyway?** box lists warnings. Click **Go back and fix**, or **Send anyway** if you accept them.',
        'Sending from the editor, a **Details are incomplete** box means your agency or the client has no address or signature on file. Add it, or send as it is. Sending from the **SOW** tab, the same notes appear in the **Send anyway?** box.',
        'If an approval workflow applies, you see **Sent for approval** and the SOW goes out when the chain clears.',
      ],
      watchFor: 'After a successful send the SOW is locked and shows **Locked after sending**. Fixing a mistake then means withdrawing and starting a new version.',
    },
    {
      title: 'Confirm it went out',
      body: 'On the **SOW** tab the status changes to **Sent**, and the project moves to **Awaiting Signature**.',
      details: [
        'If a notice says the email could not be delivered, click **Copy signing link** and send the link to the client yourself.',
        'Your client gets an email with the title \u201cPlease review and sign your project agreement\u201d, the project name, the amount and the date the link expires.',
      ],
    },
  ],
  dos: [
    'Run the review on **Preview PDF**, not just in the editor.',
    'Read every warning in **Send anyway?**. Each names something specific.',
    'Send from an account you want replies to. Your client\u2019s replies go to your address.',
    'Tell the client to expect the email, and to check spam.',
  ],
  donts: [
    'Do not rely on the send checks to catch a wrong price or a missing exclusion. They only see what is empty or inconsistent.',
    'Do not click **Send anyway** to get past warnings you have not read.',
    'Do not send while an approval request for the same SOW is pending.',
    'Do not share the signing link anywhere public. Anyone holding it can sign for your client.',
  ],
  problems: [
    {
      symptom: 'There is no **Send to client** button',
      meaning: 'You may lack permission, the SOW is not a **Draft**, or an approval request is holding it.',
      fix: 'See the article \u201cWhy can\u2019t I send this SOW?\u201d. It checks each cause in order.',
    },
    {
      symptom: '\u201cPlease verify your email before sending SOWs\u201d',
      meaning: 'Your own email address is not verified, and unverified accounts cannot email clients.',
      fix: 'Use the link in the verification email from when you signed up, then try again.',
    },
    {
      symptom: '\u201cThis SOW was edited while it was being sent. Review the latest changes and send again.\u201d',
      meaning: 'A change was saved between the last check and the send, so what was checked is not what would go out.',
      fix: 'Look at the latest text, then click **Send to client** again.',
    },
    {
      symptom: 'I sent it and spotted a mistake',
      meaning: 'A sent SOW is locked.',
      fix: 'If the client has not signed, click **Withdraw**, then **Start new version**, fix it, and send again. See the article on withdrawing and resending.',
    },
    {
      symptom: 'The SOW shows **Awaiting approval** and the client has nothing',
      meaning: 'An approval workflow matched the contract value. The SOW stays a **Draft**, locked from editing, until the chain clears.',
      fix: 'Follow it in [Approvals](/approvals). To change the SOW, cancel the request first.',
    },
  ],
  whatHappensNext: [
    'The SOW receives its document number and your client gets the signing email. The link expires after 30 days.',
    'If it is unsigned after 7 days, the project is marked **Stalled** with the reason \u201cSOW unsigned\u201d and your team is told. The SOW stays **Sent** and can still be signed.',
    'When the client signs, the project turns **Active**, the signed PDF goes to both sides, and Guardian starts monitoring.',
  ],
  related: ['why-cant-i-send-sow', 'sow-wording-terms-exclusions-payment', 'what-your-client-sees-sow', 'withdraw-revise-resend-sow'],
  updated: '2026-10-29',
}
