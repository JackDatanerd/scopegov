// lib/help/articles/complete-archive-reopen-project.ts
// Every UI label below was checked against the product code on 2026-10-29; re-check them if a screen is renamed.

import type { HelpArticle } from '../types'

export const completeArchiveReopenProject: HelpArticle = {
  slug: 'complete-archive-reopen-project',
  title: 'How do I finish, archive or reopen a project, and what happens to its documents?',
  summary: 'Move a project through Complete, Archived and back, and know what each step does to Guardian, flags, approvals and documents.',
  category: 'clients-projects',
  order: 4,
  audience: { permissions: ['MARK_PROJECT_COMPLETE'], plan: 'all' },
  shortAnswer:
    'Click **Mark complete** on an **Active** project once every change order is settled. ' +
    'From **Complete** you can **Archive** it or **Reopen** it; from **Archived** you can only **Unarchive** it, which returns it to **Complete**. ' +
    'Complete and Archived projects are read-only: no new SOWs or change orders can be sent, and Guardian stops checking client emails.',
  beforeYouStart: [
    'The project is **Active**. A paused project (status **Stalled**) must be resumed first with **Resume**.',
    'Every change order is resolved: accepted, declined or closed. One that is awaiting a reply, countered, stalled, awaiting countersignature or expired blocks completion.',
  ],
  steps: [
    {
      title: 'Mark the project complete',
      body: 'Open the project and click **Mark complete** at the top right.',
      details: [
        'If change orders are unresolved, a message says how many. Resolve them on the **Change Orders** tab and try again.',
        'Open Guardian flags are closed for you.',
        'Pending approval requests for SOWs and change orders are cancelled.',
      ],
      watchFor: 'There is no confirmation box. The project becomes **Complete** immediately.',
    },
    {
      title: 'Archive it when you are done with it (optional)',
      body: 'On a **Complete** project, click **Archive** and confirm. It moves to **Archived** and drops out of the active views.',
      details: [
        'Open [Projects](/projects) and use the **Completed** and **Archived** tabs to find it later.',
        'An archived project is still reachable from a direct link.',
      ],
    },
    {
      title: 'Bring it back',
      body: 'Click **Reopen** on a **Complete** project to make it **Active** again, or **Unarchive** on an **Archived** one to return it to **Complete**.',
      details: [
        '**Reopen** asks you to confirm. Guardian monitoring restarts.',
        'To get from **Archived** to **Active**, click **Unarchive** first, then **Reopen**.',
      ],
      watchFor: 'Reopening counts against your plan’s limit on active projects. Solo allows 3 and Starter allows 8, and drafts count too.',
    },
  ],
  dos: [
    'Settle or close every change order before you complete a project.',
    'Check the **Billing** tab for unbilled milestones before you complete: you can still invoice afterwards, but it is easy to forget.',
    'Use **Archive** to tidy up finished work rather than deleting it.',
    'Reopen the project before sending any new SOW or change order for it.',
  ],
  donts: [
    'Do not complete a project to “pause” it. Use **Pause** instead: you can undo it with **Resume**.',
    'Do not expect **Archive** to apply to an active project. It only works from **Complete**.',
    'Do not expect flags that were closed at completion to come back when you reopen.',
    'Do not complete a retainer unless you mean to stop its monthly billing: new monthly milestones are only created while the project is **Active**.',
  ],
  problems: [
    {
      symptom: 'There is no **Mark complete** button',
      meaning: 'You need the Mark Project Complete permission, and the project must be **Active**. A **Stalled**, **Draft** or **Awaiting Signature** project cannot be completed.',
      fix: 'Ask an admin for the permission. If the project is paused, click **Resume** first.',
    },
    {
      symptom: 'The message says change orders must be resolved before marking complete',
      meaning: 'One or more change orders are still open or have expired.',
      fix: 'Open the **Change Orders** tab. Resolve each one, then click **Mark complete** again.',
    },
    {
      symptom: 'The message says a document was just approved and is being sent to the client right now',
      meaning: 'An approved SOW or change order is in the middle of being sent.',
      fix: 'Wait a moment, refresh, and try again.',
    },
    {
      symptom: 'There is no **Archive** button',
      meaning: 'Only a **Complete** project can be archived, and you need the Mark Project Complete permission.',
      fix: 'Complete the project first.',
    },
    {
      symptom: 'The message says reopening would put you over the limit',
      meaning: 'Your plan limits active projects, and drafts count.',
      fix: 'Delete a draft, complete another project, or upgrade your plan.',
    },
    {
      symptom: 'A message says a SOW or change order can no longer be sent or accepted because the project is complete',
      meaning: 'Complete and Archived projects are closed to scope changes.',
      fix: 'Reopen the project, then send it again.',
    },
    {
      symptom: 'A client email you forwarded produced no flag',
      meaning: 'Guardian does not process emails for Complete or Archived projects. A manual check from the **Guardian** tab is recorded in the history without raising a flag or notifying anyone.',
      fix: 'Reopen the project if the client is still active.',
    },
  ],
  whatHappensNext: [
    'Complete and Archived: the project is read-only, **Edit** disappears, and **Guardian active** no longer shows.',
    'Completing does not stop invoicing: you can still create and send invoices, and existing invoices are not voided or locked.',
    'Nothing is emailed to the client when you complete, archive, reopen or unarchive.',
    'Every step is recorded in your audit log.',
  ],
  related: ['edit-project-before-and-after-sow', 'cant-create-co-closed-project', 'assign-team-members'],
  updated: '2026-10-29',
}
