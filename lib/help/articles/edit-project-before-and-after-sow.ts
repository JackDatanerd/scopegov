// lib/help/articles/edit-project-before-and-after-sow.ts
// Every UI label below was checked against the product code on 2026-10-29; re-check them if a screen is renamed.

import type { HelpArticle } from '../types'

export const editProjectBeforeAndAfterSow: HelpArticle = {
  slug: 'edit-project-before-and-after-sow',
  title: 'Why can’t I change my project’s client, price or type?',
  summary: 'See what you can still edit on a project, what locks when a SOW exists, and what to do instead once it is signed.',
  category: 'clients-projects',
  order: 3,
  audience: { permissions: ['CREATE_PROJECTS'], plan: 'all' },
  shortAnswer:
    'Click **Edit** on the project to change its details. The name, subtitle, start date and internal reference stay editable until the project is **Complete**. ' +
    'The client, project type and currency lock as soon as any SOW exists, even a draft. ' +
    'The price and retainer duration need the View Financials permission, are open only while the SOW is a draft, and lock for good once it is signed: after that, use a change order.',
  beforeYouStart: [
    'The project is not **Complete** or **Archived**. Those are read-only until you reopen the project.',
    'To change the price or retainer duration, you need the View Financials permission.',
  ],
  steps: [
    {
      title: 'Open the editor',
      body: 'Open the project from [Projects](/projects) and click **Edit** at the top right. The **Edit project** window opens.',
    },
    {
      title: 'Change what is still open',
      body: 'Edit the fields, then click **Save changes**. Every change is recorded in the activity log.',
      details: [
        'Always open (until Complete): **Project name**, **Subtitle (optional)**, **Start date** and **Internal reference**.',
        'Open only before any SOW exists: **Project type**, **Kind of work** (retainer), **Client** and **Currency**.',
        'Open only while the SOW is a draft: **Contract value** (or **Monthly retainer amount**) and **Retainer duration (months)**.',
      ],
      watchFor: 'The project name is printed on the SOW, change orders and invoices. The name and subtitle are read each time a PDF is generated, so renaming later changes the title on PDFs downloaded afterwards.',
    },
    {
      title: 'If the price or duration is locked, read the reason',
      body: 'A grey note under the amount says why it is locked, and what to do.',
      details: [
        'SOW out for signature: click **Withdraw** on the **SOW** tab, change the value, then send the revised SOW. The client link is deactivated when you withdraw.',
        'SOW waiting on an approval: cancel the approval request first, change the value, then resend.',
        'SOW signed: the value is final. Raise a change order from the project’s **Change Orders** tab instead.',
      ],
    },
    {
      title: 'Check the result',
      body: 'The header and **Overview** show the new values. If you changed the amount while a SOW draft exists, open the **SOW** tab and use **Regenerate from brief**, or edit the SOW, so the document matches.',
      watchFor: 'Editing the project does not rewrite an existing SOW draft for you. Check the numbers in the SOW before you send it.',
    },
  ],
  dos: [
    'Settle client, type, currency and price before you generate the SOW.',
    'Set the **Start date** before signing for a retainer: it decides the first billing month.',
    'After signing, put every price change through a change order so the client agrees in writing.',
    'Use the activity log to see who changed what.',
  ],
  donts: [
    'Do not withdraw a SOW without telling the client a revised one is coming.',
    'Do not edit a signed SOW or the price to absorb extra work: use a change order.',
    'Do not expect **Edit** on a **Complete** or **Archived** project. Reopen it first.',
    'Do not rename a project to something internal: clients see the name.',
  ],
  problems: [
    {
      symptom: 'There is no **Edit** button',
      meaning: 'You need the Create Projects permission, and the project must not be Complete or Archived.',
      fix: 'Ask an admin for the permission, or reopen the project first (see the related article).',
    },
    {
      symptom: 'The message says the client, project type and currency can no longer be changed because a SOW exists',
      meaning: 'A SOW exists for the project, even an unsent draft.',
      fix: 'These three cannot be changed. If the project was set up wrong and nothing is signed, an admin with the Delete Projects permission can delete a Draft or Intake project and you can start again.',
    },
    {
      symptom: 'The message says this project has a signed SOW and to use a change order',
      meaning: 'The price and retainer duration are locked once the SOW is signed.',
      fix: 'Open the **Change Orders** tab and raise a change order for the difference.',
    },
    {
      symptom: 'The message says a SOW is out for signature at the existing value',
      meaning: 'The client has a live signing link at the old price.',
      fix: 'Click **Withdraw** on the **SOW** tab, change the value, and send again. If the client asked for changes, withdraw that version first.',
    },
    {
      symptom: 'There is no contract value field',
      meaning: 'You do not have the View Financials permission, so the price is hidden and cannot be edited.',
      fix: 'Ask an admin to change it, or to add the permission.',
    },
    {
      symptom: 'The message says that client is archived',
      meaning: 'You cannot move a project to an archived client.',
      fix: 'Reactivate the client from its page first (**Reactivate**), or choose another client.',
    },
    {
      symptom: 'The message says the project changed while you were editing',
      meaning: 'Someone else changed it at the same moment.',
      fix: 'Refresh the page and make your change again.',
    },
  ],
  whatHappensNext: [
    'The project shows the new details straight away, and the change is added to its **Activity** tab.',
    'Nothing is emailed to the client because you edited a project.',
    'PDFs generated after the change use the new name and subtitle. Editing the project never rewrites the text of a SOW draft or a SOW you have already sent.',
  ],
  related: ['fixed-fee-or-retainer', 'complete-archive-reopen-project', 'first-project'],
  updated: '2026-10-29',
}
