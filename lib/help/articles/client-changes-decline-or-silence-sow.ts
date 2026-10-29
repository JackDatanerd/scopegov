// lib/help/articles/client-changes-decline-or-silence-sow.ts
//
// Traced to the code on 2026-10-29: app/api/portal/sow/[token]/{request-changes,decline}/route.ts, app/api/sow/[id]/{remind,reopen,link}/route.ts,
// app/api/cron/{sow-stall,sow-expiry,client-reminders}/route.ts, lib/utils/reminder-cooldown.ts, lib/utils/attention.ts,
// components/projects/ProjectDetail.tsx (SowTab), components/sow/SowEditor.tsx (change-request banner), components/settings/SettingsClient.tsx.

import type { HelpArticle } from '../types'

export const clientChangesDeclineOrSilenceSow: HelpArticle = {
  slug: 'client-changes-decline-or-silence-sow',
  title: 'My client asked for changes, declined, or hasn\u2019t answered. What now?',
  summary: 'Know what ScopeGov does for each of the three outcomes, and the one thing you do next in each case.',
  category: 'sow',
  order: 6,
  audience: { permissions: ['SEND_SOW', 'EDIT_SOW'], plan: 'all' },
  shortAnswer:
    'If the client **requests changes**, ScopeGov makes a new draft with their note at the top, and you edit it and send it again. ' +
    'If they **decline**, that SOW is closed and you start a new version when you are ready. ' +
    'If they say **nothing**, you remind them; after 7 days the project is flagged, and after 30 days the link expires and you start a new version.',
  steps: [
    {
      title: 'Find out what happened',
      body: 'You are told in the app, by email, or both, depending on your notification settings.',
      details: [
        'Notifications: \u201cChanges requested\u201d, \u201cSOW declined\u201d, \u201cSOW stalled\u201d and \u201cSOW signing link expired\u201d, each with the project name.',
        'The project is marked as needing attention, with a reason such as \u201cClient requested SOW changes\u201d or \u201cClient declined SOW\u201d.',
        'Open the project\u2019s **SOW** tab. The status next to the version tells you the outcome: **Changes Requested**, **Declined**, **Sent**, **Expired**.',
      ],
    },
    {
      title: 'If they requested changes',
      body: 'The client wrote a note, at least 20 characters, using **Request changes**. ScopeGov saved it and did the setup for you.',
      details: [
        'The version they saw is marked **Changes Requested**, and a new draft is created as the next version, a copy of what they saw.',
        'The project status becomes **Changes Requested**. Your client is emailed a receipt with their note.',
        'Open the new draft from the **SOW** tab and click **Edit**. A banner at the top of the editor shows who asked and what they wrote.',
        'If a draft was already open, the note is attached to that draft instead of making a second one.',
        'Make the changes, check the wording, and click **Send to client**. The client gets a new link.',
      ],
      watchFor: 'If the change is to the price, change the contract value on the project first (**Edit** at the top of the project), then update the Payment Terms and Payment Schedule to match.',
    },
    {
      title: 'If they declined',
      body: 'The SOW shows **Declined** and its link stops working. The client is emailed a receipt, and you are told with their reason, if they gave one.',
      details: [
        'The project stays on **Awaiting Signature** but is flagged as needing attention, so a declined SOW does not sit unnoticed.',
        'When you are ready to try again, click **Start new version** on the **SOW** tab. You get an editable copy of the declined SOW.',
        'Starting a new version returns the project to **Intake**.',
        'A decline cannot be undone. Even if the client changes their mind, they need a new version and a new link.',
      ],
    },
    {
      title: 'If they have not answered',
      body: 'First nudge them. The **SOW** tab has two buttons for a SOW that is **Sent**.',
      details: [
        '**Remind** emails the client again with the same link. You can send one every 24 hours.',
        '**Copy signing link** lets you send the link yourself by chat or another email account.',
        'To have ScopeGov chase for you, open [Settings](/settings), go to **Workspace**, and under **Client reminders** switch on **Send automatic reminders**. Then set **Remind after / every** (days) and **At most** (reminders per document). It is off by default.',
      ],
    },
    {
      title: 'What the clock does if they stay silent',
      body: 'Two things happen on their own, and you can act at either point.',
      details: [
        'After 7 days unsigned: the project is marked **Stalled** with the reason \u201cSOW unsigned\u201d and your team is told. The SOW still shows **Sent** and can still be signed. When it is signed, the project returns to **Active**.',
        'After 30 days: the link expires and the SOW shows **Expired**. Your team is told. The client now sees \u201cLink expired\u201d.',
        'For an expired SOW, click **Start new version** and send it again.',
      ],
      watchFor: 'You cannot lengthen the 30 days on a SOW that is already out. If a client needs longer, withdraw it and send a new version.',
    },
    {
      title: 'Do not start the work yet',
      body: 'None of these outcomes is a signature. Until the SOW shows **Signed**, there is no agreed scope and Guardian is not monitoring.',
    },
  ],
  dos: [
    'Read the client\u2019s note in the editor banner before you change anything.',
    'Answer a change request promptly. The project is waiting on you.',
    'Use **Remind** once or twice before deciding the client has gone quiet.',
    'Ask a client who declined what would change their answer, before you draft a new version.',
  ],
  donts: [
    'Do not start work because the client said \u201cyes\u201d in an email. The SOW has to be signed.',
    'Do not keep reminding more often than every 24 hours. ScopeGov will refuse.',
    'Do not leave a **Changes Requested** version open forever. Withdraw it when the new version is out.',
    'Do not reuse an expired link. Start a new version.',
  ],
  problems: [
    {
      symptom: '\u201cA reminder was already sent recently\u201d',
      meaning: 'Reminders are limited to one every 24 hours for each SOW.',
      fix: 'Wait, or click **Copy signing link** and send it yourself.',
    },
    {
      symptom: '\u201cThis signing link has expired. Start a new version to send the client a fresh link.\u201d',
      meaning: 'The 30 days have passed.',
      fix: 'Click **Start new version**, review it, and send it.',
    },
    {
      symptom: '\u201cThis client has no email address on file\u201d',
      meaning: 'Remind has nowhere to send to.',
      fix: 'Add an email address on the client\u2019s page in [Clients](/clients), then click **Remind**.',
    },
    {
      symptom: '\u201cThe reminder email could not be delivered\u201d',
      meaning: 'The email provider rejected the message.',
      fix: 'Click **Copy signing link** and send the link yourself. Check the client\u2019s address.',
    },
    {
      symptom: '**Start new version** is missing',
      meaning: 'It appears only for a **Withdrawn**, **Declined** or **Expired** SOW, and only if you can edit SOWs.',
      fix: 'For **Changes Requested**, the new draft already exists. Use **Edit** on it. Otherwise ask an admin for the Edit SOWs permission.',
    },
    {
      symptom: '\u201cSOW v2 is out for signature. Withdraw it before reopening an older version.\u201d or \u201cA newer version (v3) exists\u201d',
      meaning: 'Only the newest version can be started again, and only when nothing else is live.',
      fix: 'Withdraw the live version, or open the newer version that already exists.',
    },
    {
      symptom: 'The client says they requested changes but you see no new draft',
      meaning: 'The request may not have gone through. The client sees an error if saving failed.',
      fix: 'Check the **Version history** on the **SOW** tab. If nothing changed, ask the client to submit again.',
    },
  ],
  whatHappensNext: [
    'A revised version is sent as a new version with its own document number and link, and the project goes back to **Awaiting Signature**.',
    'The earlier version stays in **Version history** with its status, so you can always see what the client was shown.',
    'When the client finally signs, the project turns **Active** and Guardian starts monitoring.',
  ],
  related: ['withdraw-revise-resend-sow', 'what-your-client-sees-sow', 'review-sow-before-sending', 'why-cant-i-send-sow'],
  updated: '2026-10-29',
}
