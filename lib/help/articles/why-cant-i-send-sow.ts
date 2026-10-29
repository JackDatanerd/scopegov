// lib/help/articles/why-cant-i-send-sow.ts
//
// Troubleshooting article. Every message quoted or paraphrased here comes from the send path:
// app/api/sow/[id]/send/route.ts, lib/sow/validate-send.ts, lib/sow/payment-structure.ts, lib/documents/preflight.ts,
// lib/documents/send-sow.ts, lib/documents/client-details-gap.ts, lib/approvals/engine.ts, components/layout/LapsedBanner.tsx.
// If any of those messages change, re-check this article. Checked 2026-10-29.

import type { HelpArticle } from '../types'

export const whyCantISendSow: HelpArticle = {
  slug: 'why-cant-i-send-sow',
  title: 'Why can\u2019t I send this SOW?',
  summary: 'Every reason a SOW will not send, in the order ScopeGov checks them, and how to clear each one.',
  category: 'sow',
  order: 1,
  audience: { permissions: ['SEND_SOW'], plan: 'all' },
  shortAnswer:
    'ScopeGov checks a SOW before it reaches your client, in a fixed order. A **blocker** stops the send and tells you what to fix. ' +
    'A **warning** opens a **Send anyway?** box that you can accept. ' +
    'Most blocks are an empty required section, a payment schedule that does not add up, or a missing permission. The message names the fix, but only one at a time, so fix it and click **Send to client** again.',
  steps: [
    {
      title: 'Is the Send button there at all?',
      body: 'No **Send to client** button means the check happened before you clicked. Look at four things:',
      details: [
        '**Permission:** you need Send SOWs. Ask an admin to add it to your role.',
        '**Status:** only a **Draft** can be sent. If the SOW shows **Sent**, **Signed** or another status, it is already past this point.',
        '**Approval:** an **Awaiting approval** badge means a workflow is holding it. See the last step.',
        '**Read-only workspace:** a banner saying **This workspace is read-only** means your trial or subscription ended. Someone with billing access needs to click **Choose a plan**.',
      ],
    },
    {
      title: 'Check the account and the project',
      body: 'These stop the send when you click **Send to client**.',
      details: [
        '\u201cPlease verify your email before sending SOWs\u201d: confirm your own email address using the verification email sent when you signed up.',
        '\u201cThis project is complete\u201d (or archived): click **Reopen** at the top of the project, then send.',
        '\u201cThis project\u2019s client has no email address\u201d: add one on the client\u2019s page in [Clients](/clients).',
        '\u201cThis project already has a signed SOW\u201d: a signed SOW cannot be replaced. Use a change order to change the agreed scope.',
        '\u201cSOW v2 for this project is still out for signature\u201d: click **Withdraw** on the earlier version first. A project can have only one live SOW.',
      ],
    },
    {
      title: 'Fill in the required sections',
      body: 'Open **Edit** and complete whatever the message names. A SOW cannot be sent while any of these is empty:',
      details: [
        '**Contract value** greater than zero (edit the project if it is zero).',
        '**Deliverables**: at least one row.',
        '**Out of Scope**: write the exclusions, or write \u201cNone\u201d if nothing is excluded.',
        '**Payment Terms**, **Parties**, **Governing Law** and **Signatures**.',
        '**Limitation of Liability**: if it is shown it needs a clause. Add one, or hide the section.',
        'At least one visible section overall.',
      ],
      watchFor: 'Do not hide a required section to get past this. Fill it in; the editor will not let you hide the core ones.',
    },
    {
      title: 'Make the payment structure and schedule agree',
      body: 'The way the SOW bills must match the project, and a milestone schedule must add up to the contract value.',
      details: [
        'A retainer project must use monthly billing, and only a retainer can. If the message says the payment structure does not match the project, click **Regenerate from brief** on the **SOW** tab and choose the right structure.',
        'With milestone payments, the **Payment Schedule** needs at least one milestone and must be visible.',
        '\u201cCouldn\u2019t read the amount on the Payment Schedule milestone\u201d: enter that amount as a plain number.',
        '\u201cThe Payment Schedule totals X but the contract value is Y\u201d: change the milestone amounts, or the contract value on the project, until they match.',
      ],
    },
    {
      title: 'Decide about the warnings',
      body: 'A **Send anyway?** box lists things worth a second look. They do not block the send. Read each one; click **Go back and fix** to fix it, or **Send anyway** to accept it.',
      details: [
        'The **Payment Terms** text does not state the contract value, the tax rate, or the late fee that invoices will use.',
        'A section still contains placeholder wording such as \u201cTo be confirmed\u201d.',
        'The start date is already in the past, or Governing Law names only \u201cUnited States\u201d.',
        'The Revision Policy leaves the client review period to be agreed later. Set a standard review window in [Settings](/settings), or state it in the Revision Policy.',
        'Your agency has no business address, agency signature or signatory name on file. Add them in [Settings](/settings) under **Workspace** (address) or **Branding** (signature and name), or the SOW goes out without them.',
        'The client has no billing address on file. Add it on the client\u2019s page, or accept that it goes out without one.',
      ],
    },
    {
      title: 'If an approval workflow is involved',
      body: 'When a workflow matches the contract value, **Send to client** sends the SOW for approval instead. You will see **Sent for approval**, and the client receives it once the chain clears.',
      details: [
        'Follow it in [Approvals](/approvals). The SOW stays a **Draft** until the chain clears, so if an approver rejects it, revise it and send again.',
        '\u201cApproved but could not be sent\u201d: click **Retry send** on the **SOW** tab (or in [Approvals](/approvals)), or click **Cancel request** to start over.',
        '\u201cJust approved and is being sent right now\u201d: wait a moment, refresh, and look again before clicking anything.',
        '\u201cAn approval workflow applies to this document but has no approvers configured\u201d: an admin needs to fix the workflow in [Settings \u2192 Approvals](/settings/approvals).',
      ],
    },
  ],
  dos: [
    'Read the first message in full. It names exactly what to fix.',
    'Use **Preview PDF** after fixing, to see what the client will see.',
    'Accept a warning only when you mean it, and know why.',
    'Fix the payment schedule to match the contract value, not the other way round, once the price is agreed.',
  ],
  donts: [
    'Do not hide a required section to get past a message.',
    'Do not leave \u201cTo be confirmed\u201d in a SOW the client will sign.',
    'Do not change the contract value after drafting without updating the Payment Terms text.',
    'Do not click **Send to client** repeatedly while an approval is pending.',
  ],
  problems: [
    {
      symptom: 'I fixed it and it still will not send',
      meaning: 'The message shows only the first problem. There may be others behind it.',
      fix: 'Fix what it names and click **Send to client** again. Repeat until the **Send anyway?** box or the send itself appears.',
    },
    {
      symptom: 'The message does not show the contract value',
      meaning: 'Members without permission to view financials do not see amounts in these messages. The checks still run.',
      fix: 'Ask someone who can view financials to look at the project, or to have the permission added to your role.',
    },
    {
      symptom: '**Send anyway?** appears every time',
      meaning: 'Warnings are checked on every send and stay until the SOW text or your settings change.',
      fix: 'Fix the cause, or click **Send anyway** if you have decided it is fine.',
    },
    {
      symptom: 'It says it was sent, but the client got nothing',
      meaning: 'The send succeeded, but the email provider could not deliver the message.',
      fix: 'Click **Copy signing link** on the **SOW** tab and send the link to your client yourself.',
    },
  ],
  whatHappensNext: [
    'The SOW status changes to **Sent**, it receives its document number, and your client gets an email with a signing link.',
    'The link expires after 30 days by default. Use **Remind** to nudge your client.',
    'Once it is **Signed**, the project turns **Active** and Guardian starts monitoring.',
  ],
  related: ['first-project'],
  updated: '2026-10-29',
}
