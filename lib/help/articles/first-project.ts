// lib/help/articles/first-project.ts
//
// THE REFERENCE ARTICLE. Every later article copies this one's shape, length and voice (see lib/help/AUTHORING.md).
// Every UI label below was checked against the product code on 2026-10-29; re-check them if a screen is renamed.

import type { HelpArticle } from '../types'

export const firstProject: HelpArticle = {
  slug: 'first-project',
  title: 'Your first project, end to end in 30 minutes',
  summary: 'Go from a new client to a signed SOW, with every screen in order and nothing skipped.',
  category: 'getting-started',
  order: 1,
  audience: { permissions: ['CREATE_PROJECTS', 'EDIT_SOW', 'SEND_SOW'], plan: 'all' },
  shortAnswer:
    'You create a project, ScopeGov drafts the Statement of Work (SOW) from your brief, you review it and send it, and your client signs on a link. ' +
    'Signing is what switches Guardian on, so the project starts protected from day one. ' +
    'Expect about 30 minutes of your own time, plus however long your client takes to sign.',
  beforeYouStart: [
    'Your workspace is set up. If you skipped onboarding steps, your agency name and SOW defaults are in [Settings](/settings).',
    'Your client\u2019s name and email address, and the person who will sign for them.',
    'The agreed price and currency, and whether sales tax applies.',
    'Something to describe the work: a client email, call notes, or your own bullet points.',
  ],
  steps: [
    {
      title: 'Start a project',
      minutes: 1,
      body: 'Open [Projects](/projects) and click **New project**. A three-step wizard opens: **Basics**, **Brief**, **Review & Send**.',
    },
    {
      title: 'Fill in the basics',
      minutes: 4,
      body: 'Pick the client and describe the deal, then click **Continue**.',
      details: [
        '**Client**: search for an existing client, or click **+ New client** and enter a name and email.',
        '**Contracting company** and signer\u2019s title: only if the client signs for a company. Leave blank if they sign personally.',
        '**Project name**: this is printed on the SOW, change orders and invoices your client receives, so write it for them.',
        '**Project type**: choose the closest match. Choose **Retainer** for a recurring monthly engagement.',
        '**How is it billed?**: **One fixed fee** for a whole project, or **Same fee every month** for a retainer.',
        '**Contract value** and **Currency**. For a retainer, the contract value is the monthly amount.',
        '**Sales tax**: a rate, then **Included in the amount** or **Added on top**. Choose carefully; it carries through to every change order and invoice.',
      ],
      watchFor: '**Continue** stays greyed out until the project has a name and a client. A new client also needs an email address.',
    },
    {
      title: 'Describe the scope in the brief',
      minutes: 6,
      body: 'This text becomes your SOW, and Guardian later measures client requests against it, so specific beats short.',
      details: [
        '**AI pre-fill**: paste a client email or call notes and click **Extract scope**. Check every field it fills in.',
        '**Manual**: type the fields yourself.',
        '**Objective**, **Deliverables** (one per line), **Out of scope** (one per line), **Timeline**, **Payment structure** and **Revision rounds**.',
        'Click **Review** when you are done. It needs at least an objective or a deliverable.',
      ],
      watchFor: 'Do not skip **Out of scope**. It is the list Guardian uses to spot extra work, and a SOW cannot be sent without that section filled in.',
    },
    {
      title: 'Generate the SOW',
      minutes: 2,
      body: 'On **Review & Send**, check the summary, then click **Generate SOW**. A few moments later you land on the project\u2019s **SOW** tab with a draft ready.',
      watchFor: 'If a banner says the draft came from the standard template, AI drafting was unavailable or this month\u2019s AI drafts are used up. The draft is still usable, but read every section before sending.',
    },
    {
      title: 'Review and edit the draft',
      minutes: 10,
      body: 'On the **SOW** tab, click **Edit**. Changes save as you go, and you will see **Saved** when they do. Use **Preview PDF** to read it as your client will.',
      details: [
        'Read the numbers first: contract value, **Payment Schedule** amounts, tax wording.',
        'Make sure **Deliverables** and **Out of Scope** say exactly what you mean. They become the baseline for scope monitoring.',
        'Fill in **Parties**, **Payment Terms**, **Governing Law** and **Signatures**. A SOW with any of them empty cannot be sent.',
        'Hide sections you do not want to include rather than leaving them empty. Replace any placeholder wording such as \u201cTo be confirmed\u201d.',
      ],
    },
    {
      title: 'Send it to your client',
      minutes: 3,
      body: 'Back on the **SOW** tab, click **Send to client**. Your client gets an email with a signing link.',
      details: [
        'If something must be fixed first, a message names it. Fix it and click **Send to client** again.',
        'If you get a **Send anyway?** box, those are warnings, not blockers. Read them and decide.',
        'If your workspace uses approval workflows, you will see **Sent for approval** and the SOW goes out once approved.',
      ],
      watchFor: 'If the email could not be delivered, ScopeGov tells you. Click **Copy signing link** and send the link yourself.',
    },
    {
      title: 'Your client signs',
      body: 'Your client opens the link, reads the agreement and clicks **Sign agreement**. They type their name, draw their signature, and can add their title and company. They can also choose **Request changes** or **Decline**.',
      details: [
        'The SOW status shows **Sent** until they respond, then **Signed**, **Changes Requested** or **Declined**.',
        'Still waiting? Click **Remind** on the **SOW** tab. The link expires after 30 days by default.',
      ],
    },
    {
      title: 'Check that the project is live',
      minutes: 2,
      body: 'Once the SOW is **Signed**, the project turns **Active**. Open the **Guardian** tab to find the project\u2019s forwarding email address, and the **Billing** tab to see the payment milestones created from the SOW.',
    },
  ],
  dos: [
    'Put every exclusion in **Out of scope**, in writing, before the client signs.',
    'Use **Preview PDF** before sending and read it as your client will.',
    'Ask the client who signs for them, and use that person\u2019s name and title.',
    'Check tax and currency twice. They flow into change orders and invoices.',
  ],
  donts: [
    'Do not send a SOW you have not read, even when AI drafted it.',
    'Do not leave placeholder wording such as \u201cTo be confirmed\u201d in a SOW.',
    'Do not edit a signed SOW. New work after signing goes through a change order.',
    'Do not start the work before the SOW shows **Signed**.',
  ],
  problems: [
    {
      symptom: '**Continue** or **Review** is greyed out',
      meaning: 'A required field is missing.',
      fix: 'Basics needs a project name and a client (a new client also needs an email address). The brief needs at least an objective or a deliverable.',
    },
    {
      symptom: 'There is no **Send to client** button',
      meaning: 'You may not have permission to send SOWs, the SOW is already out, or it is waiting on an approval.',
      fix: 'Ask an admin for the Send SOWs permission, or check the status next to the SOW version. Only a **Draft** can be sent.',
    },
    {
      symptom: 'Sending is blocked with a message',
      meaning: 'Something required is missing or unreadable, for example an empty **Out of Scope** section, a contract value of zero, or no milestone in the **Payment Schedule**.',
      fix: 'Do what the message says in the SOW editor, then click **Send to client** again.',
    },
    {
      symptom: 'The client says they never got the email',
      meaning: 'It may be in spam, or the address may be wrong.',
      fix: 'Click **Copy signing link** and send it to them directly. Check the address on the client record.',
    },
    {
      symptom: 'The client asked for changes',
      meaning: 'They used **Request changes** on the signing page. The SOW shows **Changes Requested** and a new draft is created for you.',
      fix: 'Open the new draft from the **SOW** tab. Their note is shown at the top of the editor. Make the changes and send it again.',
    },
    {
      symptom: 'The signing link says it has expired',
      meaning: 'Unsigned SOWs expire after 30 days by default.',
      fix: 'Open the **SOW** tab, click **Start new version**, review it, and send it again.',
    },
  ],
  whatHappensNext: [
    'Guardian starts checking client messages against your signed scope. Forward client emails to the address on the **Guardian** tab.',
    'Payment milestones appear on the **Billing** tab, ready to invoice.',
    'When the client asks for something outside the SOW, raise a change order from the project\u2019s **Change Orders** tab instead of absorbing the work.',
  ],
  related: [],
  updated: '2026-10-29',
}
