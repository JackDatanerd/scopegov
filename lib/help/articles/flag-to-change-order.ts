// lib/help/articles/flag-to-change-order.ts
// Checked against the product code on 2026-10-29: app/api/guardian/flags/[id] (draft_co), lib/documents/finalize-co.ts,
// app/api/co/[id]/close, app/api/cron/co-expiry, FlagCard in ProjectDetail.

import type { HelpArticle } from '../types'

export const flagToChangeOrder: HelpArticle = {
  slug: 'flag-to-change-order',
  title: 'How do I turn a scope flag into a change order?',
  summary: 'Click Draft CO on an open flag, finish the draft, and see what happens to the flag when the client accepts, declines or ignores it.',
  category: 'guardian',
  order: 6,
  audience: { permissions: ['CREATE_CHANGE_ORDERS'], plan: 'all' },
  shortAnswer:
    'On the **Guardian** tab, click **Draft CO** on an **Open** flag. ScopeGov creates a draft change order for that project and opens it. ' +
    'The price is blank and the description is Guardian’s sentence for your team, so rewrite both before you send. ' +
    'If the client accepts, the flag is resolved. If the change order is declined, closed, withdrawn or expires, the flag goes back to **Open**.',
  beforeYouStart: [
    'The Create change orders permission.',
    'A signed SOW, and a project that is not Complete or Archived.',
    'The flag is **Open**. A **Needs review** flag must be confirmed first.',
  ],
  steps: [
    {
      title: 'Read the request',
      body: 'On the flag, click **View original request** to see exactly what the client asked for, so your change order describes it accurately.',
    },
    {
      title: 'Confirm a borderline flag first',
      body: 'If the flag says **Needs review**, someone with Approve flags clicks **Confirm out of scope**. It becomes **Open** and shows **Draft CO**.',
      watchFor: 'If it was not extra work after all, click **Dismiss** instead.',
    },
    {
      title: 'Click Draft CO',
      body: 'Click **Draft CO** on the Open flag. The change order editor opens with a draft titled “Change Order — …” followed by the deliverable Guardian matched, or “General scope”.',
      details: [
        'It has one line item with quantity 1, rate 0 and total 0.',
        'The tax rate comes from your workspace defaults.',
        'The flag now reads **CO Created**.',
      ],
    },
    {
      title: 'Finish the draft',
      body: 'Replace the title and the line item description with what you will actually deliver, set the price, and add any timeline or scope note.',
      watchFor: 'The line item description is Guardian’s one-sentence reason for flagging, written for your team. Your client sees the change order, so reword it.',
    },
    {
      title: 'Send it',
      body: 'Send the change order as you normally would. See “Creating and sending a change order” for the steps, including approvals.',
    },
  ],
  dos: [
    'Confirm the price and wording before sending. The draft starts at zero.',
    'Add the client’s original wording to the note if it helps to show what is being priced.',
    'Raise the change order before doing the work.',
    'Leave the flag alone while its change order is live. Its status follows the change order.',
  ],
  donts: [
    'Do not send the draft with Guardian’s reasoning as the description.',
    'Do not draft a second change order for the same flag. Only one is allowed.',
    'Do not leave an unwanted draft sitting around. The flag stays on **CO Created** until that change order is finished one way or another.',
    'Do not use **Draft CO** for work you plan to give away. Use **Exception** on the Open flag instead.',
  ],
  problems: [
    {
      symptom: 'There is no **Draft CO** button',
      meaning: 'You lack Create change orders, or the flag is not **Open**. Needs review, CO Created, Resolved and Closed flags do not show it.',
      fix: 'Ask an admin for the permission, or **Confirm out of scope** first, or **Reopen** a closed flag.',
    },
    {
      symptom: '“This project has no signed SOW yet — a change order can only be created once the original scope of work is signed.”',
      meaning: 'A change order amends a signed SOW.',
      fix: 'Get the SOW signed first.',
    },
    {
      symptom: '“This project is complete — a change order can no longer be created. Reopen the project first.”',
      meaning: 'The project is Complete or Archived.',
      fix: 'Reopen the project, then click **Draft CO** again.',
    },
    {
      symptom: '“A change order has already been drafted from this flag”',
      meaning: 'The flag already has one. It reads **CO Created**.',
      fix: 'Open the project’s **Change orders** tab and continue that one.',
    },
    {
      symptom: 'The flag went back to **Open** on its own',
      meaning: 'Its change order was declined, closed, withdrawn or expired.',
      fix: 'Decide again: draft a new change order, grant an **Exception**, or **Close** the flag.',
    },
  ],
  whatHappensNext: [
    'The flag is **CO Created** while the change order is a draft, sent, countered or stalled.',
    'Accepted: the flag becomes **Resolved** and cannot be reopened. The change order’s deliverables become part of what Guardian treats as in scope, so a repeat request shows as covered.',
    'Declined, closed, withdrawn or expired: the flag returns to **Open**, and your team can act on it again.',
    'Follow the change order itself on the project’s **Change orders** tab. The flag’s status simply mirrors it.',
  ],
  related: ['understand-flag-statuses', 'create-and-send-co', 'when-to-write-a-co'],
  updated: '2026-10-29',
}
