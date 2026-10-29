// lib/help/articles/cant-create-co-closed-project.ts
// Checked against the product code on 2026-10-29: api/co (create), send, revise, accept-counter, lib/utils/project-status.ts,
// ProjectDetail header (Reopen, Unarchive, Mark complete, New CO), api/projects/[id]/complete.

import type { HelpArticle } from '../types'

export const cantCreateCoClosedProject: HelpArticle = {
  slug: 'cant-create-co-closed-project',
  title: 'Why can\u2019t I create a change order on a closed project?',
  summary: 'Complete and Archived projects are finished, so ScopeGov will not amend them. Here is how to reopen one.',
  category: 'change-orders',
  order: 5,
  audience: { permissions: ['CREATE_CHANGE_ORDERS'], plan: 'all' },
  shortAnswer:
    'A change order amends a signed agreement for work still in progress. Once a project is Complete or Archived, ScopeGov treats it as finished and refuses to create, send, revise or accept change orders on it. ' +
    'To continue, reopen the project, then create the change order.',
  beforeYouStart: [
    'The permission to mark projects complete, which is also what lets you reopen one.',
    'A reason to reopen. If the new work is a separate engagement, a new project is often cleaner.',
  ],
  steps: [
    {
      title: 'Check the project status',
      body: 'Open the project and look at its status under the title. **Complete** and **Archived** are closed.',
      details: [
        'Only **Active** and **Stalled** projects show **New CO**.',
        'A project with no signed SOW does not show it either, whatever its status.',
      ],
    },
    {
      title: 'Unarchive first if it is Archived',
      body: 'Click **Unarchive** and confirm. The project returns to Complete and reappears in active project views.',
    },
    {
      title: 'Reopen a Complete project',
      body: 'Click **Reopen** at the top of the project and confirm. It returns to Active and Guardian monitoring restarts.',
      details: [
        'Flags that were closed automatically when you completed the project stay closed.',
        'If you need the old request again, raise it afresh.',
      ],
    },
    {
      title: 'Create the change order',
      body: 'Go to **Change orders** and click **New CO**. See the article 201cCreating and sending a change order201d.',
    },
    {
      title: 'Mark the project complete again when you are done',
      body: 'Click **Mark complete**. It is refused while any change order is awaiting a response, countered, stalled, awaiting countersignature or expired.',
      details: [
        'Settle each one first: wait for the client, **Close**, **Withdraw** or accept the counter.',
        'A change order you revised and re-sent no longer blocks, because the newer version carries the decision.',
      ],
    },
  ],
  dos: [
    'Settle open change orders before you mark a project complete.',
    'Reopen only for work that belongs to the original engagement.',
    'Use a new project and SOW for a new engagement.',
    'Check who has permission to reopen before you promise a client a change.',
  ],
  donts: [
    'Do not reopen a project to hide a late request inside an old contract.',
    'Do not expect an old flag to come back after reopening.',
    'Do not leave a change order awaiting response on a project you plan to finish.',
    'Do not try to accept a countered change order on a closed project. It will be refused.',
  ],
  problems: [
    {
      symptom: '\u201cThis project is complete \u2014 a change order can no longer be created. Reopen the project first.\u201d',
      meaning: 'The project is Complete or Archived.',
      fix: 'Follow the steps above. The message says \u201carchived\u201d for an archived project.',
    },
    {
      symptom: 'There is no **Reopen** button',
      meaning: 'You lack the permission to mark projects complete, or the project is Archived.',
      fix: 'Click **Unarchive** first, or ask someone with that permission.',
    },
    {
      symptom: '\u201cThis project has no signed SOW yet\u201d',
      meaning: 'That is the other reason a change order is refused, separate from closure.',
      fix: 'Get the SOW signed. A change order amends a signed SOW.',
    },
    {
      symptom: '\u201cN change orders must be resolved before marking complete\u201d',
      meaning: 'Some are still open or expired.',
      fix: 'Open each from the list shown, and close, withdraw or settle it.',
    },
    {
      symptom: 'A change order I sent is now refused to send, revise or accept',
      meaning: 'The project was completed while it was in flight.',
      fix: 'Reopen the project and try again.',
    },
  ],
  whatHappensNext: [
    'After reopening, the project is Active, **New CO** appears and Guardian checks requests again.',
    'Change orders already accepted stay accepted. Reopening does not undo them.',
    'The reopen and the later completion are recorded in the project history.',
  ],
  related: ['when-to-write-a-co', 'create-and-send-co'],
  updated: '2026-10-29',
}
