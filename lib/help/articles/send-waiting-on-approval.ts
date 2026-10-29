// lib/help/articles/send-waiting-on-approval.ts
// Labels and claims checked against the product code on 2026-10-29: components/projects/ProjectDetail.tsx (Awaiting approval badge,
// Sent for approval, Retry send, Cancel request), components/approvals/ApprovalsClient.tsx (tabs, statuses, Reassign step, Cancel request,
// Retry send, cancel confirmations), lib/approvals/engine.ts (gate, reassign, messages), app/api/cron/approval-stall/route.ts,
// lib/utils/attention.ts (APPROVAL_STALL_DAYS = 2).

import type { HelpArticle } from '../types'

export const sendWaitingOnApproval: HelpArticle = {
  slug: 'send-waiting-on-approval',
  title: 'My send is waiting on approval: who has it, and what if they are away?',
  summary: 'See where a held document is, nudge the approver, reassign or cancel it, and recover a send that was approved but did not go out.',
  category: 'approvals',
  order: 4,
  audience: { permissions: ['SEND_SOW'], plan: 'starter' },
  shortAnswer:
    'When a workflow matches, **Send to client** sends the document for approval instead. It stays a draft, marked **Awaiting approval**, until the chain clears, then goes out by itself. ' +
    'Follow it under **My requests** in [Approvals](/approvals). If the approver is away, a workspace admin can **Reassign step**. You can also **Cancel request** to take it back.',
  steps: [
    {
      title: 'Confirm it is an approval hold',
      minutes: 1,
      body: 'After you click **Send to client** you see **Sent for approval**. On the project, the document shows **Awaiting approval** with the step, for example 1/2.',
      details: [
        'The document stays an editable draft. The client has not been sent anything.',
        'The same applies to change orders, invoices and accepting a client\u2019s counter-offer when a workflow matches.',
      ],
    },
    {
      title: 'See who has it',
      minutes: 1,
      body: 'Open [Approvals](/approvals) and the **My requests** tab, then click the request. The steps show who must approve and who already did. A step may be a named person or \u201cAny\u201d plus a role.',
      details: [
        'You will see **Pending** while it is waiting, **Approved**, **Rejected** or **Cancelled** when it is done.',
        'People with **View All Projects** or **Manage Workspace Settings** can see every request on **All requests**.',
      ],
    },
    {
      title: 'Nudge or wait',
      body: 'Ask the approver directly. ScopeGov also reminds them after 2 days, and raises an alert if nobody assigned to the step can be reached.',
    },
    {
      title: 'If the approver is away, reassign',
      minutes: 2,
      body: 'A workspace admin opens the request and clicks **Reassign step**, chooses a person or \u201cAny\u201d role, adds a reason if wanted, then clicks **Reassign step** again.',
      details: [
        'Only someone with **Manage Workspace Settings** sees the button.',
        'The new approver must hold **Approve Documents**, be able to see the project and, unless the workflow allows it, not be the person who sent it.',
        'The reason is recorded in the audit log.',
      ],
    },
    {
      title: 'Or take it back',
      minutes: 1,
      body: 'You, or an admin, can click **Cancel request** on a pending request. The document goes back to being an editable draft.',
      watchFor: 'Sending it again needs a fresh approval, and any approvals already given are lost.',
    },
    {
      title: 'If it was approved but did not go out',
      minutes: 1,
      body: 'A request that shows **Approved \u2014 not sent** was approved, but the automatic send failed. Click **Retry send** on the request or on the project. Nobody needs to approve again.',
      details: [
        '**Cancel request** here abandons the send. If the document did not go out, it returns to a draft.',
        'A request showing **Sent \u2014 email bounced** was sent but the email could not be delivered. Send the signing link to the client yourself.',
      ],
    },
  ],
  dos: [
    'Tell the approver you have sent something, so it does not wait unseen.',
    'Name a role as approver in the workflow, so cover is automatic.',
    'Use **Retry send** for an approved send that failed, not a new request.',
    'Check **My requests** before you resend or cancel.',
  ],
  donts: [
    'Do not click **Send to client** repeatedly while it is pending.',
    'Do not cancel a request that has nearly cleared. You will lose the approvals.',
    'Do not edit the document and expect approvers to see it, without telling them.',
    'Do not approve your own request unless the workflow allows it.',
  ],
  problems: [
    {
      symptom: '\u201cThis document was just approved and is being sent to the client right now\u201d',
      meaning: 'The final approval landed and the send is in progress.',
      fix: 'Wait a moment, refresh, and look again before you click anything.',
    },
    {
      symptom: 'Sending is refused because nobody can approve',
      meaning: 'A workflow applies but the approver has left, lost the permission, or cannot see the project, or the workflow has no approvers.',
      fix: 'Ask an admin to fix the workflow in [Settings \u2192 Approvals](/settings/approvals), then send again.',
    },
    {
      symptom: 'The request was rejected',
      meaning: 'An approver sent it back with a reason.',
      fix: 'Read the reason in your notification or in the request, revise the document and send again.',
    },
    {
      symptom: 'I cannot see **Reassign step**',
      meaning: 'It needs the Manage Workspace Settings permission, and the request must still be pending.',
      fix: 'Ask an admin to reassign it.',
    },
  ],
  whatHappensNext: [
    'When the last approver approves, the document is sent to the client and its status changes as normal.',
    'If it is rejected or cancelled, it stays a draft you can edit and send again, with a new approval.',
    'Every decision, reassignment and cancellation is recorded in the audit log.',
  ],
  related: ['approve-or-reject-document', 'build-approval-workflow', 'why-cant-i-send-sow'],
  updated: '2026-10-29',
}
