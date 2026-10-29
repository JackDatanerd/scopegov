// lib/help/articles/withdraw-revise-resend-sow.ts
//
// Traced to the code on 2026-10-29: app/api/sow/[id]/{withdraw,reopen,send}/route.ts, app/api/sow/[id]/route.ts (PATCH lock messages),
// lib/documents/{send-sow,sow-version}.ts, components/projects/ProjectDetail.tsx (SowTab buttons), app/(app)/projects/[id]/sow/[sowId]/page.tsx,
// lib/pdf/sow-watermark.ts. Re-check the button labels and messages if the SOW tab changes.

import type { HelpArticle } from '../types'

export const withdrawReviseResendSow: HelpArticle = {
  slug: 'withdraw-revise-resend-sow',
  title: 'How do I withdraw, revise and resend a SOW?',
  summary: 'Fix a SOW that has already gone to the client, without losing the record of what they were shown.',
  category: 'sow',
  order: 7,
  audience: { permissions: ['SEND_SOW', 'EDIT_SOW'], plan: 'all' },
  shortAnswer:
    'A sent SOW is locked, so you never edit it. If it is still out for signature, click **Withdraw**. Then click **Start new version**, which gives you an editable copy as the next version, change it, and click **Send to client** again. ' +
    'A signed SOW cannot be withdrawn or replaced. New work after signing goes through a change order.',
  beforeYouStart: [
    'Know which status the SOW is in. It is shown next to the version on the **SOW** tab.',
    'Permission: Send SOWs to withdraw and send, and Edit SOWs to start a new version and edit.',
  ],
  steps: [
    {
      title: 'Find your situation',
      body: 'What you do depends on the SOW\u2019s status.',
      details: [
        '**Draft**: not sent yet. Click **Edit** and change it. Nothing else is needed.',
        '**Sent**: out for signature. Click **Withdraw**, then **Start new version**.',
        '**Changes Requested**: a new draft already exists. Edit that draft. See the article on changes, declines and silence.',
        '**Withdrawn**, **Declined** or **Expired**: click **Start new version**.',
        '**Signed**: it cannot be changed. Create a change order from the project\u2019s **Change Orders** tab.',
      ],
    },
    {
      title: 'Withdraw the SOW',
      body: 'On the **SOW** tab, click **Withdraw** and confirm \u201cWithdraw this SOW? The client link will be deactivated.\u201d',
      details: [
        'The SOW shows **Withdrawn**. The client\u2019s link stops working: they see \u201cSOW withdrawn\u201d.',
        'Your client is emailed a notice that the SOW was withdrawn.',
        'The project goes back to **Intake**. If another version is still out for signature, the project stays as it is.',
        'If the client signs in the same moment, their signature wins and the withdraw is refused.',
      ],
      watchFor: 'If your own email is not verified, or the address is rejected, the withdrawal still happens but the client is not told. A notice on screen says so. Tell them yourself.',
    },
    {
      title: 'Start a new version',
      body: 'Click **Start new version**. The editor opens on a new draft, the next version number, copied from the one you withdrew.',
      details: [
        'Your sections, tables, settings and attachments are carried over. The client\u2019s old change-request note is not.',
        'The old version stays in **Version history**. Use **View** or **PDF**, and you will see it stamped **WITHDRAWN**, **DECLINED** or **EXPIRED**.',
        'A project can have only one draft. If one already exists, you are taken to it.',
        'Only the newest version can be started again.',
      ],
    },
    {
      title: 'Make the changes',
      body: 'Edit the draft like any other. Take the change all the way through the document.',
      details: [
        'If the price changed, update the contract value on the project first, then the Payment Terms text and any **Payment Schedule**.',
        'To redraft from a new brief instead, click **Regenerate from brief**. It overwrites your edits to the text.',
        'Use **Preview PDF** to check the result.',
      ],
    },
    {
      title: 'Send it again',
      body: 'Click **Send to client**. The same checks run as for any send.',
      details: [
        'The client gets a new email, a new link that lasts 30 days, and the new version number. A new version has its own document number.',
        'If an approval workflow matches, it needs approval again.',
        'The project returns to **Awaiting Signature**.',
      ],
      watchFor: 'Tell the client in your own words that a corrected version is coming. The automatic withdrawal email does not explain what is changing.',
    },
  ],
  dos: [
    'Withdraw as soon as you know the SOW is wrong. A client can sign it while you work.',
    'Check the whole document after a change, not just the line you fixed.',
    'Keep the old version. It is the record of what the client saw.',
    'Use a change order for anything after signing.',
  ],
  donts: [
    'Do not send a second SOW while the first is still out. ScopeGov refuses, and it would confuse the client.',
    'Do not expect to edit a sent SOW. The editor is locked and shows **Locked after sending**.',
    'Do not withdraw a signed SOW. It cannot be done.',
    'Do not forget the Payment Terms text when the price changes.',
  ],
  problems: [
    {
      symptom: '\u201cThis SOW has already been sent. Start a new version to make changes.\u201d',
      meaning: 'You tried to edit a SOW that has left your hands.',
      fix: 'Withdraw it if it is still out for signature, then click **Start new version**.',
    },
    {
      symptom: '\u201cSOW v2 for this project is still out for signature. Withdraw it before sending another version.\u201d',
      meaning: 'A project can have only one live SOW.',
      fix: 'Click **Withdraw** on the version that is out, then send the new one.',
    },
    {
      symptom: '\u201cThis project already has a signed SOW. Use a change order to change the agreed scope.\u201d',
      meaning: 'Once signed, the agreement is fixed.',
      fix: 'Create a change order for the new work from the project\u2019s **Change Orders** tab.',
    },
    {
      symptom: '\u201cSOW cannot be withdrawn in current status\u201d or \u201cThis SOW was already acted on by another action\u201d',
      meaning: 'The SOW has already been signed, declined or withdrawn, perhaps seconds ago.',
      fix: 'Refresh the **SOW** tab and read the new status before you do anything else.',
    },
    {
      symptom: '\u201cThis project is complete \u2014 a SOW can no longer be reopened. Reopen the project first.\u201d',
      meaning: 'Complete and archived projects cannot take a new SOW.',
      fix: 'Click **Reopen** at the top of the project, then **Start new version**.',
    },
    {
      symptom: '\u201cThis SOW has a pending approval request \u2014 cancel it before editing.\u201d',
      meaning: 'An approval workflow is holding the draft, and it cannot change under the approvers.',
      fix: 'Cancel the request from [Approvals](/approvals) or the **SOW** tab, then edit.',
    },
    {
      symptom: 'I withdrew it by mistake',
      meaning: 'A withdrawal cannot be undone, and the old link stays dead.',
      fix: 'Click **Start new version**, check it, and send it. The client receives a new link.',
    },
  ],
  whatHappensNext: [
    'The withdrawn version stays in **Version history**, readable and downloadable, with a **WITHDRAWN** stamp.',
    'The new version is sent as a fresh offer. Until it is signed, the project is **Awaiting Signature**.',
    'If the client does not respond, the usual 7-day flag and 30-day expiry start again from the new send date.',
  ],
  related: ['client-changes-decline-or-silence-sow', 'review-sow-before-sending', 'why-cant-i-send-sow', 'create-and-send-co'],
  updated: '2026-10-29',
}
