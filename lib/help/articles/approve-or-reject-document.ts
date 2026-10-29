// lib/help/articles/approve-or-reject-document.ts
// Labels and claims checked against the product code on 2026-10-29: components/approvals/ApprovalsClient.tsx (tabs, decision modal),
// lib/approvals/engine.ts (recordApprovalDecision, rejection and notification paths, error messages), lib/approvals/eligibility.ts.

import type { HelpArticle } from '../types'

export const approveOrRejectDocument: HelpArticle = {
  slug: 'approve-or-reject-document',
  title: 'How do I approve or reject a document?',
  summary: 'Find what is waiting for you, decide with a note, and know what happens to the document and the person who sent it.',
  category: 'approvals',
  order: 3,
  audience: { permissions: ['APPROVE_DOCUMENTS'], plan: 'starter' },
  shortAnswer:
    'Open [Approvals](/approvals), go to **My queue**, open the request, read the document, then click **Approve** or **Reject**. ' +
    'Approving passes it to the next approver, or sends it to the client if you are last. Rejecting needs a reason and returns the document to the person who sent it.',
  steps: [
    {
      title: 'Find what is waiting for you',
      minutes: 1,
      body: 'Click **Approvals** in the sidebar. The number beside it is what is waiting. Your requests are on the **My queue** tab.',
      details: [
        'You see **My queue** only if you hold **Approve Documents**.',
        '\u201cNothing waiting on you\u201d means no request is currently at your step.',
        'The table shows the **Document**, **Project**, **Requested by**, **Step**, **Amount** and **Status**.',
      ],
    },
    {
      title: 'Open it and read the document',
      minutes: 3,
      body: 'Click the request. The steps are listed with who approved or rejected each, and who is current. Click **Open the SOW to review before deciding** (it names the document type) to read the document itself in the project.',
      watchFor: 'Check the price, the scope and the dates. Once you approve the last step, the document goes to the client automatically.',
    },
    {
      title: 'Approve',
      minutes: 1,
      body: 'Add a **Note (optional)** if the requester should know something, then click **Approve**.',
      details: [
        'If more steps follow, the next approver is notified.',
        'If you were the last approver, the document is sent to the client automatically.',
        'If the automatic send fails, you are told. The requester can retry from Approvals, and nobody needs to approve again.',
      ],
    },
    {
      title: 'Or reject',
      minutes: 2,
      body: 'Click **Reject**, write the **Reason for rejection**, then click **Submit rejection**. A reason is required.',
      details: [
        'Say what must change, so the sender can fix it in one go.',
        'The sender is notified with your reason. The document stays an editable draft, and nothing reaches the client.',
        'After they revise it and send again, it goes through a new approval.',
      ],
    },
    {
      title: 'If you cannot decide',
      body: 'You can only decide a request if you are assigned to the current step, hold **Approve Documents**, can see the project, and the workflow rules allow it.',
      details: [
        '\u201cYou requested this \u2014 it needs to be decided by someone else\u201d: you sent it, and the workflow does not allow self-approval.',
        '\u201cYou already approved an earlier step of this request\u201d: the workflow needs a different person for each step.',
        '\u201cYou are not an approver for this step\u201d: it is assigned to someone else, or to a role you do not hold.',
        'Tell a workspace admin if you should have been assigned. They can reassign the step.',
      ],
    },
  ],
  dos: [
    'Open the document before you decide. The row only shows the amount.',
    'Give a clear reason when you reject.',
    'Decide soon. Approvers are reminded after 2 days, and the client is waiting.',
    'Turn on two-factor authentication. **Approve Documents** is a sensitive permission.',
  ],
  donts: [
    'Do not approve to clear your queue without reading.',
    'Do not reject without a reason. It is required anyway, and vague reasons cost a round trip.',
    'Do not ask someone to approve your own send unless the workflow allows self-approval.',
    'Do not sit on a request if you are away. Ask an admin to reassign it.',
  ],
  problems: [
    {
      symptom: 'My queue is empty but I was told something is waiting',
      meaning: 'It may be assigned to another person or role, or you may not be able to see the project.',
      fix: 'Ask an admin to check the step on the request, or to give you access to the project.',
    },
    {
      symptom: 'There is no **Approve** button',
      meaning: 'You cannot decide this one: you sent it, you approved an earlier step, or it is not your step yet.',
      fix: 'Read the line under the steps in the request. It says why. If it should be yours, ask an admin.',
    },
    {
      symptom: '\u201cThis step was reassigned to someone else just now\u201d',
      meaning: 'An admin moved the step while you had it open.',
      fix: 'Refresh and check who the current approver is.',
    },
    {
      symptom: 'I approved, but it says it could not be sent',
      meaning: 'The decision is recorded. Only the automatic send failed.',
      fix: 'The requester can click **Retry send** in Approvals. You do not need to approve again.',
    },
  ],
  whatHappensNext: [
    'The decision is recorded in the audit log with your note.',
    'On approval, the next approver is notified, or the document goes to the client.',
    'On rejection, the sender is notified and can revise and send again.',
  ],
  related: ['build-approval-workflow', 'send-waiting-on-approval', 'permissions-decoder'],
  updated: '2026-10-29',
}
