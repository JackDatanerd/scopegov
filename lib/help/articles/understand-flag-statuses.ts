// lib/help/articles/understand-flag-statuses.ts
// Checked against the product code on 2026-10-29: app/api/guardian/flags/[id] (every action and its guards), FlagCard,
// ExceptionModal, EscalateFlagModal, CloseFlagModal in ProjectDetail, lib/utils/format.ts (status labels),
// app/api/cron/guardian-flag-stall, migration 133 role seeds.

import type { HelpArticle } from '../types'

export const understandFlagStatuses: HelpArticle = {
  slug: 'understand-flag-statuses',
  title: 'What do the flag statuses mean, and what should I do with each?',
  summary: 'Open, Needs review, CO Created, Resolved, Closed, Escalated and exceptions: what each means, which buttons you get, and what can be undone.',
  category: 'guardian',
  order: 3,
  audience: { permissions: ['APPROVE_FLAGS'], plan: 'all' },
  shortAnswer:
    'A flag is **Open** when Guardian is confident a request is extra work, and **Needs review** when it is only borderline. ' +
    'From there you can draft a change order (**CO Created**), mark it **Resolved**, set it aside as **Closed**, or give the work away with an **Exception**. ' +
    'Resolve and Close can be reopened. A change order outcome and an exception cannot.',
  beforeYouStart: [
    'Approve flags lets you Resolve, Escalate, Close, Confirm, Dismiss and Reopen.',
    'Draft CO needs Create change orders. Exception needs Grant exceptions, which only the Owner role has until you change it.',
  ],
  steps: [
    {
      title: 'Open the flag list',
      body: 'Open the project’s **Guardian** tab. The chips **All**, **Open**, **Needs review**, **CO Created**, **Resolved** and **Closed** filter the list. Use **View original request** on a flag to read the client’s words, who pasted or sent them, and any attachment names.',
    },
    {
      title: 'Handle an Open flag',
      body: 'An **Open** flag shows a severity (high, medium or low) and these buttons.',
      details: [
        '**Draft CO**: creates a draft change order and takes you to it. The flag becomes **CO Created**.',
        '**Resolve**: marks it **Resolved** when you have dealt with it another way. You can still **Reopen** or **Close** it afterwards.',
        '**Exception**: gives the work to the client for free. You must enter a **Reason**, and can record **What’s being granted** and an **Estimated value**. This is the audit trail for scope granted without a change order.',
        '**Escalate**: asks someone to step in. Choose **Escalate to**, then explain in **Why is this being escalated?** (at least 10 characters). The status does not change and the flag gets an **Escalated** badge.',
        '**Close**: sets it aside without resolving it or drafting a change order. A reason is optional.',
      ],
    },
    {
      title: 'Handle a Needs review flag',
      body: 'A **Needs review** flag is Guardian’s “not sure”. You make the call.',
      details: [
        '**Confirm out of scope**: turns it into an **Open** flag, with a severity worked out from Guardian’s confidence, and tells your team.',
        '**Dismiss**: it was fine after all. The flag is **Closed** and can be reopened later.',
        '**Escalate**: ask someone else to decide.',
        'You cannot draft a change order or grant an exception straight from Needs review. Confirm it first.',
      ],
    },
    {
      title: 'Follow it afterwards',
      body: 'Resolved, Closed and CO Created flags stay on the list for your records.',
      details: [
        '**Resolved** by you can be reopened or closed.',
        '**Resolved** by an accepted change order is final.',
        '**Resolved** by an exception is final. It appears under **Exceptions granted** at the bottom of the tab, where you can still edit the description, reason and value.',
        '**Closed** can be reopened, unless it came from a change order.',
      ],
    },
  ],
  dos: [
    'Look at **View original request** before you decide. The verdict is a summary, the source is the truth.',
    'Use **Escalate** when a client is pushing back, so someone senior sees it.',
    'Write a clear **Reason** when you grant an exception. It is your record of why work was free.',
    'Clear **Needs review** flags promptly. They get the same reminders as open ones.',
  ],
  donts: [
    'Do not use **Exception** when you meant **Close**. An exception cannot be undone.',
    'Do not leave flags sitting. After 5 days with no action, Guardian reminds everyone who can approve flags, and repeats every 5 days.',
    'Do not use **Resolve** to hide a request you have not dealt with.',
    'Do not expect to escalate to someone who is not on the project. Add them to its team first.',
  ],
  problems: [
    {
      symptom: 'There are no buttons on a flag',
      meaning: 'Your role lacks the permission, or the flag’s status does not allow the action.',
      fix: 'Ask an admin for Approve flags, Create change orders or Grant exceptions as needed.',
    },
    {
      symptom: '“This flag was just changed by someone else — refresh and try again.”',
      meaning: 'A teammate acted on the flag at the same moment.',
      fix: 'Refresh the page and look at its new status.',
    },
    {
      symptom: '“A reason is required to grant an exception”',
      meaning: 'The **Reason** box was empty.',
      fix: 'Write why you are giving this work away, then click **Grant exception**.',
    },
    {
      symptom: '“doesn’t have access to this project. Add them to the project first”',
      meaning: 'The person you chose to escalate to cannot open the project.',
      fix: 'Add them on the project’s **Team** tab, or choose someone else.',
    },
    {
      symptom: '“This project is complete — its scope flags are read-only apart from closing or resolving them”',
      meaning: 'Exception, Escalate, Confirm out of scope and Reopen are blocked on a Complete or Archived project.',
      fix: 'Reopen the project first, or just Resolve or Close the flag.',
    },
    {
      symptom: 'There is no **Reopen** on a flag',
      meaning: 'Only flags you Resolved or Closed yourself can be reopened. Exceptions and change order outcomes cannot.',
      fix: 'If an exception was a mistake, record the new work as a change order instead.',
    },
  ],
  whatHappensNext: [
    'Each action is recorded in your audit log with who did it.',
    'Reopening a flag you dismissed as not out of scope sends it back to **Needs review**. Any other reopened flag goes back to **Open**.',
    'When a project is marked complete, flags that are still open are closed for you.',
    'Your client never sees flags or their statuses.',
  ],
  related: ['check-client-message-verdict', 'flag-to-change-order', 'complete-archive-reopen-project'],
  updated: '2026-10-29',
}
