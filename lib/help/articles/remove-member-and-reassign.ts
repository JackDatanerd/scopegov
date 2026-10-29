// lib/help/articles/remove-member-and-reassign.ts
// Checked 2026-10-29 against: api/team/[id] (DELETE, PATCH reactivate), deactivate_member_atomic / archive/restore_member_projects,
// lib/utils/owner-protection.ts, approvals reassign (api/approvals/[id]/reassign, ApprovalsClient), approval-stall cron.

import type { HelpArticle } from '../types'

export const removeMemberAndReassign: HelpArticle = {
  slug: 'remove-member-and-reassign',
  title: 'Removing a team member and handing over their work',
  summary: 'Switch someone off safely, then make sure their projects and approvals do not get stuck.',
  category: 'team-permissions',
  order: 5,
  audience: { permissions: ['INVITE_MEMBERS'], plan: 'all' },
  shortAnswer:
    'On the [Team](/team) page, click **Deactivate** on the person\u2019s card. They lose access immediately and the seat is freed. Nothing they created is deleted. ' +
    'Their project assignments are set aside, and approval steps that named them need to be reassigned.',
  beforeYouStart: [
    'The Invite Members permission. You also need every permission the person holds, because you cannot deactivate someone with more access than you.',
    'A list of the projects and approval workflows the person was part of.',
  ],
  steps: [
    {
      title: 'Deactivate the member',
      body: 'On **Team**, find the person and click **Deactivate**. Confirm: \u201cThey will lose workspace access immediately. Their project assignments are kept aside and restored if you reactivate them.\u201d',
      details: [
        'You cannot deactivate yourself.',
        'The workspace owner cannot be deactivated by anyone else. They hand ownership over first, from Settings \u2192 Danger zone.',
        'Invitations that person had sent and nobody accepted are revoked.',
      ],
    },
    {
      title: 'Put someone else on their projects',
      body: 'Their assignments are removed from the projects. For each project they were on, open **Team** and click **Add member** for the replacement.',
      details: [
        'Anyone with **View All Projects** already sees every project.',
        'Documents and invoices they created stay exactly as they were.',
      ],
    },
    {
      title: 'Reassign pending approvals',
      body: 'Open [Approvals](/approvals). On a pending request that was waiting on them, click **Reassign step**, choose a new approver (from **People**, or **Anyone holding a role**), add an optional reason and confirm.',
      details: [
        'Reassigning needs the permission to manage workspace settings.',
        'Only a request still waiting on an approver can be reassigned.',
        'Also edit the workflow in Settings \u2192 Approvals so future requests do not go to them.',
      ],
      watchFor: 'Deactivating does not block when a workflow names the person. The audit log records which workflows were affected.',
    },
    {
      title: 'Check flags and open work',
      body: 'If a Guardian flag was escalated to them, open it and escalate it again to a colleague. Check the project\u2019s change orders and invoices for anything waiting on them.',
    },
    {
      title: 'Bring them back if needed',
      body: 'Click **Reactivate** in the **Deactivated** list. Their project assignments are restored.',
      details: [
        'It needs a free seat on your plan.',
        'It is not possible if the person deleted their own account. Send a new invite instead.',
      ],
    },
  ],
  dos: [
    'Reassign approvals before the person leaves, not after.',
    'Deactivate the same day someone leaves.',
    'Check the audit log entry to see which workflows they were in.',
    'Hand over ownership first if the person is the owner.',
  ],
  donts: [
    'Do not share the departing person\u2019s login.',
    'Do not leave an approval step on a deactivated person. It will sit until it is reassigned.',
    'Do not assume projects move automatically. Add the replacement yourself.',
    'Do not deactivate the last person who can manage roles.',
  ],
  problems: [
    {
      symptom: '\u201cYou cannot deactivate yourself\u201d',
      meaning: 'It is blocked so nobody locks themselves out.',
      fix: 'Ask another admin.',
    },
    {
      symptom: 'The owner\u2019s access cannot be changed by anyone else',
      meaning: 'The workspace owner is protected.',
      fix: 'They hand ownership over from Settings \u2192 Danger zone first.',
    },
    {
      symptom: '\u201cCannot deactivate a member who holds permissions you don\u2019t have yourself\u201d',
      meaning: 'You cannot remove someone more powerful than you.',
      fix: 'Ask an Owner.',
    },
    {
      symptom: '\u201cThis person deleted their account, so it can\u2019t be reactivated\u201d',
      meaning: 'There is no account to switch back on.',
      fix: 'Send a new invitation.',
    },
    {
      symptom: 'An approval has been waiting a long time',
      meaning: 'The approver may be deactivated. After repeated reminders you are told to reassign the step.',
      fix: 'Click **Reassign step** on the Approvals page.',
    },
  ],
  whatHappensNext: [
    'The seat is freed straight away.',
    'The deactivated person appears under **Deactivated** and can be reactivated later.',
    'The deactivation, and any workflows it affected, are recorded in the audit log.',
  ],
  related: ['invite-team-and-roles', 'per-project-access', 'build-approval-workflow'],
  updated: '2026-10-29',
}
