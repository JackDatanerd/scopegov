// lib/help/articles/do-you-need-approvals.ts
// Labels and claims checked against the product code on 2026-10-29: components/settings/ApprovalWorkflowsClient.tsx,
// lib/approvals/{pick-workflow,gate-amount,eligibility,engine}.ts, lib/billing/entitlements.ts (approvalMaxSteps, approvalPlanGate),
// app/api/{sow,co,invoices}/[id]/send and co/[id]/accept-counter (the routes that call the approval gate).

import type { HelpArticle } from '../types'

export const doYouNeedApprovals: HelpArticle = {
  slug: 'do-you-need-approvals',
  title: 'Do you need approval workflows?',
  summary: 'Decide whether a sign-off step is worth having before a SOW, change order or invoice reaches a client, and what it costs in speed.',
  category: 'approvals',
  order: 1,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'starter' },
  shortAnswer:
    'An approval workflow holds a SOW, change order or invoice, or your acceptance of a client\u2019s counter-offer, until named people sign off, then sends it automatically. ' +
    'It is worth it when a mistake is costly or several people can send. It is not worth it when one person writes, checks and sends everything. ' +
    'Starter allows one approver step per workflow, Pro and Agency allow longer chains, and Solo has no workflows.',
  beforeYouStart: [
    'A rough idea of which documents worry you: big contracts, anything a junior sends, or every invoice.',
    'Who you would trust to sign off, and whether they will be around when something is waiting.',
  ],
  steps: [
    {
      title: 'Check how you work today',
      body: 'Ask three questions. If the answer to all three is \u201cno problem\u201d, you can stop here.',
      details: [
        'Can more than one person send documents to clients?',
        'Has a document with a wrong price, scope or wording ever gone out?',
        'Do large documents go out without a second pair of eyes?',
      ],
    },
    {
      title: 'Decide what to hold',
      body: 'A workflow covers one document type: **SOW**, **change order** or **invoice**. Holding a client\u2019s counter-offer on a change order uses the change order workflow.',
      details: [
        'With no value threshold, a workflow holds every document of that type.',
        'With a threshold, it holds documents at that value and above. A common split is a light check for everything, plus a stricter chain for large amounts.',
        'The amount compared is what the document commits the client to: a change order\u2019s own total, and for a fixed-term retainer the full term, not one month.',
      ],
      watchFor: 'A threshold only compares amounts in its own currency. Documents in another currency are not held unless you tick **Also require this approval for documents in other currencies**.',
    },
    {
      title: 'Decide how many approvers',
      body: 'One step is one sign-off. More steps are a chain: each must clear before the next person is asked.',
      details: [
        '**Solo** has no approval workflows. **Starter** allows one approver step per workflow. **Pro** and **Agency** allow longer chains.',
        'Approvers need the **Approve Documents** permission. Give it only to people you trust with money decisions.',
        'On a chain, **A different person must approve each step** is on by default, so one person cannot clear the whole chain alone.',
      ],
    },
    {
      title: 'Plan for a small team',
      body: 'If only one person can approve, they cannot approve what they send themselves, and everything they send would stick.',
      details: [
        'Either give a second person **Approve Documents**, or tick **The person who sends it may also approve it** on the workflow.',
        'With self-approval on, the gate is a deliberate pause, not a second opinion. Use it only when that is what you want.',
      ],
    },
    {
      title: 'Count the cost, then set it up',
      body: 'Every held document waits for a human. ScopeGov reminds the approver after 2 days, but a send is only as fast as your approvers.',
      details: [
        'Name a role rather than one person, so anyone holding that role can act when someone is away.',
        'Start with one workflow on your largest documents, then tighten if you need to.',
        'When you are ready, follow \u201cHow do I set up an approval workflow?\u201d.',
      ],
    },
  ],
  dos: [
    'Start with the documents where a mistake would hurt most.',
    'Name a role as approver so someone is always available.',
    'Keep the approver list short and trusted.',
    'Tell the team the rule exists, so a held send does not look like a bug.',
  ],
  donts: [
    'Do not gate every document if one person checks everything anyway.',
    'Do not name one person as the only approver if they are often away.',
    'Do not give **Approve Documents** to people you would not trust with the price.',
    'Do not set a threshold in one currency and forget your other currencies.',
  ],
  problems: [
    {
      symptom: 'The approvals settings say workflows are \u201cavailable on the Starter plan and above\u201d',
      meaning: 'Your workspace is on the Solo plan, which has no approval workflows.',
      fix: 'Click **See plans** and upgrade, or keep checking documents yourself before you send.',
    },
    {
      symptom: 'A two-step chain says it needs the Pro plan',
      meaning: 'Starter allows one approver step per workflow.',
      fix: 'Use one step, or move to Pro or Agency for longer chains.',
    },
    {
      symptom: 'Sends get stuck because only one person can approve',
      meaning: 'That person cannot approve their own sends unless the workflow allows it.',
      fix: 'Give a second person **Approve Documents**, or tick **The person who sends it may also approve it**.',
    },
  ],
  whatHappensNext: [
    'If you decide to use approvals, build the workflow in [Settings \u2192 Approvals](/settings/approvals).',
    'Held documents then show **Awaiting approval** on the project, and approvers find them in [Approvals](/approvals).',
  ],
  related: ['build-approval-workflow', 'permissions-decoder'],
  updated: '2026-10-29',
}
