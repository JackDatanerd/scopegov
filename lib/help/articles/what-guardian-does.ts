// lib/help/articles/what-guardian-does.ts
// Checked against the product code on 2026-10-29: lib/ai/guardian.ts, lib/ai/guardian-pipeline.ts, app/api/guardian/*,
// lib/documents/post-signing.ts (scope snapshot), GuardianTab in ProjectDetail, migration 133 role seeds.

import type { HelpArticle } from '../types'

export const whatGuardianDoes: HelpArticle = {
  slug: 'what-guardian-does',
  title: 'What does Guardian do, and what doesn’t it do?',
  summary: 'Guardian compares client requests with your signed SOW and raises a flag when something looks like extra work. Here is exactly what it reads, what it ignores, and who gets told.',
  category: 'guardian',
  order: 1,
  audience: { permissions: ['SUBMIT_GUARDIAN_CHECKS'], plan: 'all' },
  shortAnswer:
    'Guardian reads a client message that you paste in, or forward to the project’s Guardian address, and compares it with the deliverables and exclusions in your signed SOW, plus any accepted change orders. ' +
    'It gives you a verdict and, if the request looks like new work, raises a flag for your team. ' +
    'It never contacts your client, never changes your documents, and never decides for you: it is a second pair of eyes, not a referee.',
  beforeYouStart: [
    'A signed SOW. Guardian switches on when the client signs, and the project turns **Active**.',
    'To paste messages you need the Submit Guardian checks permission. To act on flags you need Approve flags.',
  ],
  steps: [
    {
      title: 'Know what Guardian compares against',
      body: 'When the SOW is signed, ScopeGov saves a snapshot of two lists from it. Guardian measures every request against these.',
      details: [
        'The **Deliverable** column of the SOW’s deliverables table. Only the deliverable names are used, not their descriptions, dates or revision counts.',
        'The items listed in the SOW’s **Out of scope** section.',
        'The deliverables added by any accepted change order.',
        'Guardian’s verdicts are only as good as those names. “Website” matches almost anything, while “5-page marketing website with contact form” does not.',
      ],
    },
    {
      title: 'Feed it client messages',
      body: 'Guardian only sees what you give it. Open the project’s **Guardian** tab, then either click **Paste email or message**, or forward the client’s email to the address shown under **Forward client emails to**.',
      details: [
        'There is no automatic watching of your inbox, chat tools or calls.',
        'Each message is judged on its own. Guardian does not remember earlier messages.',
      ],
    },
    {
      title: 'Read the verdict',
      body: 'A verdict is one of **In scope**, **Covered by an accepted change order**, **Borderline** or **Out of scope**. The last two create a flag on the Guardian tab.',
      details: [
        'Your teammates who have the Approve flags permission get a notification, and an email for out-of-scope flags. You are not notified about a flag you triggered yourself.',
        'A flag nobody touches for 5 days triggers a reminder to the same people.',
      ],
    },
    {
      title: 'Decide what to do',
      body: 'On each flag you choose: **Draft CO**, **Resolve**, grant an **Exception**, **Escalate**, or **Close**. Guardian suggests, your team decides.',
    },
  ],
  dos: [
    'Write specific deliverable names in the SOW. Guardian can only be as precise as they are.',
    'Fill in **Out of scope** properly. Items listed there are treated as strongly excluded.',
    'Paste or forward each new client request as soon as it arrives.',
    'Treat a verdict as a prompt to look, then judge it yourself.',
  ],
  donts: [
    'Do not treat “In scope” as agreement. Guardian does not know what you have promised verbally.',
    'Do not expect it to read attachments, screenshots, images or links. It reads text only.',
    'Do not expect it to warn you about deadlines, revision counts or payment terms. It only judges what work is being asked for.',
    'Do not rely on it for messages you never pasted or forwarded.',
  ],
  problems: [
    {
      symptom: 'The Guardian tab says **Guardian not yet active**',
      meaning: 'The SOW has not been signed yet, so there is no scope to compare against.',
      fix: 'Get the SOW signed. Anything you paste before then is saved and checked automatically once it is signed.',
    },
    {
      symptom: 'The Guardian tab says **Guardian paused**',
      meaning: 'The project is paused. Forwarded emails are not checked while paused, but pasting still works.',
      fix: 'Click **Resume** on the project when you are ready to restart monitoring.',
    },
    {
      symptom: 'The Guardian tab says **Guardian inactive**',
      meaning: 'The project is Complete or Archived. Emails are ignored, and pasted checks are recorded without raising a flag.',
      fix: 'Reopen the project if work is continuing.',
    },
    {
      symptom: 'I cannot see the Guardian tab’s paste or history buttons',
      meaning: 'Your role lacks Submit Guardian checks or Access Guardian history.',
      fix: 'Ask an admin to add the permission to your role.',
    },
  ],
  whatHappensNext: [
    'Your client sees nothing. Checks, verdicts and flags are internal.',
    'Every check is kept under **Check history**, including those that raised no flag.',
    'Accepted change orders extend what Guardian treats as in scope, so the same request is recognised next time.',
  ],
  related: ['check-client-message-verdict', 'forward-client-emails-to-guardian', 'understand-flag-statuses'],
  updated: '2026-10-29',
}
