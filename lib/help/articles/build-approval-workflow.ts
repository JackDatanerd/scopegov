// lib/help/articles/build-approval-workflow.ts
// Labels and claims checked against the product code on 2026-10-29: components/settings/ApprovalWorkflowsClient.tsx (list, editor,
// live warnings), app/(app)/settings/approvals/page.tsx, lib/approvals/pick-workflow.ts, lib/approvals/gate-amount.ts,
// lib/approvals/eligibility.ts, lib/billing/entitlements.ts.

import type { HelpArticle } from '../types'

export const buildApprovalWorkflow: HelpArticle = {
  slug: 'build-approval-workflow',
  title: 'How do I set up an approval workflow?',
  summary: 'Create a workflow with a value threshold, one or more approver steps and the right rules, and check that it can actually clear.',
  category: 'approvals',
  order: 2,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'starter' },
  shortAnswer:
    'Open [Settings \u2192 Approvals](/settings/approvals), click **New workflow** under SOW, change order or invoice workflows, name it, optionally set a value threshold, add approver steps and choose the rules. ' +
    'ScopeGov warns you if the workflow could never clear. Documents that match are held until the chain signs off, then sent automatically.',
  beforeYouStart: [
    'At least one person with the **Approve Documents** permission who is not the only sender. See [Team](/team).',
    'A decision on which document type, which value, and how many steps. See \u201cDo you need approval workflows?\u201d.',
  ],
  steps: [
    {
      title: 'Open the workflows and start a new one',
      minutes: 1,
      body: 'Go to [Settings \u2192 Approvals](/settings/approvals). The page lists **SOW workflows**, **Change order workflows** and **Invoice workflows**. Click **New workflow** in the section you want.',
      watchFor: 'If **New workflow** is disabled, your plan does not include approval workflows. A banner explains and offers **See plans**.',
    },
    {
      title: 'Name it and set the value',
      minutes: 2,
      body: 'Give it a **Name** that says what it does, such as \u201cSOWs over $25k\u201d.',
      details: [
        'Leave **Only apply above a value threshold** unticked to hold every document of this type, in any currency.',
        'Tick it to choose a currency and an amount. The workflow then holds documents at that amount and above, in that currency only.',
        'Tick **Also require this approval for documents in other currencies** to hold every document in another currency whatever its size. Amounts are never converted.',
      ],
    },
    {
      title: 'Add the approver steps',
      minutes: 3,
      body: 'Each step has an **Approver type**: **Role** or **Person**. Each step must clear before the next is notified.',
      details: [
        '**Role**: any active member holding that role can act. Best for cover when someone is away.',
        '**Person**: one named member. Use only when it really must be them.',
        'Roles and people without **Approve Documents** are shown as \u201ccan\u2019t approve \u2014 missing permission\u201d and cannot be chosen.',
        'Use the up and down arrows to reorder steps and the cross to remove one. **Add step** is limited by your plan.',
      ],
    },
    {
      title: 'Choose the rules',
      minutes: 1,
      body: 'Under **Rules**:',
      details: [
        '**A different person must approve each step**: shown on chains of two or more steps, and on by default.',
        '**The person who sends it may also approve it**: off by default. Turn it on for a solo or very small team.',
      ],
    },
    {
      title: 'Read the warnings, then save',
      minutes: 2,
      body: 'Before you click **Create workflow**, read any amber warning. ScopeGov flags a workflow that saves fine but could never clear:',
      details: [
        'A step has nobody who can approve it right now.',
        'Only one person can approve, and they cannot approve their own sends.',
        'The chain has more steps than there are different approvers.',
        'Projects billed in another currency will not be held by this threshold.',
      ],
      watchFor: 'You can save with a warning showing. Fix it first, or a send will be refused until someone can decide.',
    },
    {
      title: 'Check it in the list',
      minutes: 1,
      body: 'Each workflow shows when it applies, its steps in order and any rule flags. A red line means a step has nobody who can approve it right now.',
      details: [
        'The switch pauses or enables a workflow. A paused workflow holds nothing.',
        '**Edit** changes it. The bin removes it, or pauses it instead if it already has approval history.',
        'If several workflows match a document, the one with the highest threshold that the amount reaches wins. A workflow with no threshold applies last.',
      ],
    },
  ],
  dos: [
    'Name steps by role so the workflow survives holidays and departures.',
    'Test it with a real document the first time.',
    'Check the red \u201cnobody can approve\u201d line after you change roles or remove people.',
    'Keep one catch-all and one stricter tier at most, until you need more.',
  ],
  donts: [
    'Do not create two workflows with the same threshold and expect a particular one to win.',
    'Do not forget other currencies if you bill in more than one.',
    'Do not leave a workflow pointing at someone who has left.',
    'Do not turn on self-approval and then expect a second opinion.',
  ],
  problems: [
    {
      symptom: 'The role I want is greyed out with \u201cmissing permission\u201d',
      meaning: 'That role does not include **Approve Documents**.',
      fix: 'Add the permission to the role on [Team](/team) \u2192 **Roles**, or choose a different role. Editing roles needs **Manage Roles**.',
    },
    {
      symptom: 'The workflow shows a red \u201cnobody who can approve\u201d line',
      meaning: 'The approver left, was deactivated, lost the permission, or cannot see the project.',
      fix: 'Click **Edit** and choose someone who can approve, or give the existing person the permission and project access.',
    },
    {
      symptom: 'A large document went out with no approval',
      meaning: 'The workflow may be paused, set to another currency, or the document is under the threshold.',
      fix: 'Check the switch, the currency and whether the amount reaches the threshold. Remember the amount is what the document commits the client to.',
    },
    {
      symptom: 'I cannot add a second step',
      meaning: 'Starter allows one approver step per workflow.',
      fix: 'Use one step, or upgrade to Pro or Agency.',
    },
  ],
  whatHappensNext: [
    'From now on, matching documents are held when someone clicks **Send to client**. The project shows **Awaiting approval**.',
    'Approvers are notified and decide in [Approvals](/approvals). Once the chain clears, the document is sent automatically.',
    'Changes to a workflow apply to documents sent after the change.',
  ],
  related: ['do-you-need-approvals', 'approve-or-reject-document', 'permissions-decoder'],
  updated: '2026-10-29',
}
