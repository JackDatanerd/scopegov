// lib/help/articles/plan-limits.ts
// Numbers and wording checked against the product code on 2026-10-29: lib/billing/entitlements.ts (seats, projects, aiDraftsPerMonth),
// lib/utils/project-status.ts (LIMIT_COUNTED_STATUSES), lib/utils/project-limit.ts (messages), lib/utils/seat-limit.ts (what counts, message),
// lib/utils/rate-limit.ts (aiDraftQuotaMessage), components/settings/SettingsClient.tsx (Billing tab usage line).

import type { HelpArticle } from '../types'

export const planLimits: HelpArticle = {
  slug: 'plan-limits',
  title: 'What do seats, active projects and AI drafts count, and what happens at the limit?',
  summary: 'Know exactly what uses up your plan\u2019s allowances, how to see where you stand, and how to make room.',
  category: 'billing-plans',
  order: 1,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Each plan limits three things: seats (active members and pending invitations), active projects (anything not yet Complete or Archived, drafts included) and AI drafts per month. ' +
    'Reaching a limit only stops the next thing that would go over it. Nothing is deleted and nothing already sent is affected.',
  steps: [
    {
      title: 'See where you stand',
      minutes: 1,
      body: 'Open [Settings](/settings?tab=billing) \u2192 **Billing**. **Current plan** shows your plan and, under it, **AI drafts this month** with the date it resets. The [Team](/team) page shows seats in use, for example \u201c2 of 3 seats in use\u201d.',
    },
    {
      title: 'Seats',
      body: 'A seat is used by every active member and by every pending invitation that has not expired.',
      details: [
        'Solo has 1 seat, Starter 3, Pro 5, Agency 10. A trial has 10.',
        'Deactivated members and expired invitations do not use a seat.',
        'At the limit you see: \u201cThis workspace is at its 3-seat limit on the Starter plan. Deactivate a member or upgrade in Settings \u2192 Billing first.\u201d',
        'To make room: **Deactivate** a member or **Revoke** a pending invitation on the Team page, or move to a bigger plan.',
      ],
    },
    {
      title: 'Active projects',
      body: 'A project counts while it is a **Draft**, **Intake**, **Active**, **Awaiting Signature**, **Changes Requested** or **Stalled**. **Complete** and **Archived** projects do not count.',
      details: [
        'Solo allows 3 active projects and Starter 8. Pro, Agency and the trial have no limit.',
        'Drafts count. The new-project wizard creates one at the first step, so an abandoned draft quietly uses a slot.',
        'Reopening a completed project counts again, so it can be refused at the limit.',
        'At the limit you see: \u201cYour Solo plan is limited to 3 active projects (drafts count; completed and archived projects don\u2019t).\u201d',
        'To make room: delete an abandoned draft, complete or archive a finished project, or upgrade.',
      ],
      watchFor: 'Finished projects cannot be deleted, which is why they do not count. Complete them rather than leaving them open.',
    },
    {
      title: 'AI drafts',
      body: 'Each time ScopeGov drafts something for you it uses one AI draft: extracting scope from a brief, generating a SOW, regenerating a section, drafting a change order and drafting an invoice.',
      details: [
        'Per month: Solo 60, Starter 200, Pro 600, Agency 1,500. A trial has 600.',
        'The allowance resets on the first of each calendar month, in UTC.',
        'Guardian checks are not counted.',
        'When it runs out you see: \u201cThis workspace has used the 200 AI drafts included in the Starter plan this month\u2026 Upgrade in Settings \u2192 Billing for more, or write this part by hand.\u201d',
      ],
      watchFor: 'Writing by hand never uses a draft. Regenerating a section to tweak one sentence does, so edit small changes yourself.',
    },
    {
      title: 'Make room, or move up',
      minutes: 2,
      body: 'If you are regularly at a limit, compare plans on the **Billing** tab under **Available plans**. The plan cards show seats, projects and AI drafts side by side.',
      details: [
        'Switching to a smaller plan is refused while you are over its seat or project limit. Reduce first, then switch.',
        'See \u201cHow do I switch plans, update my card, cancel or resume?\u201d for the steps and what switching costs.',
      ],
    },
  ],
  dos: [
    'Delete drafts you will not finish, so they stop using a project slot.',
    'Complete projects as soon as the work is done.',
    'Revoke old pending invitations. They hold a seat until they expire.',
    'Check **AI drafts this month** before a big drafting session.',
  ],
  donts: [
    'Do not leave finished projects open to \u201ckeep them handy\u201d. Complete them; they stay viewable.',
    'Do not regenerate whole sections for small edits.',
    'Do not assume a limit deletes anything. It only blocks the next addition.',
    'Do not plan on exceeding a limit and fixing it later. Switching down is refused while over.',
  ],
  problems: [
    {
      symptom: 'I cannot create a project but I only have a few',
      meaning: 'Drafts and in-progress projects all count, and the wizard\u2019s unfinished drafts are included.',
      fix: 'Open [Projects](/projects), delete drafts you will not finish, or complete finished projects.',
    },
    {
      symptom: 'I cannot invite someone although nobody new has joined',
      meaning: 'Pending invitations hold a seat until they are accepted, revoked or expired.',
      fix: 'Revoke unused invitations on the Team page, or upgrade.',
    },
    {
      symptom: 'Drafting stopped working mid-month',
      meaning: 'The workspace has used its AI drafts for the month.',
      fix: 'Write that part by hand, wait for the reset date shown on **Billing**, or upgrade.',
    },
    {
      symptom: 'Reopening a project is refused',
      meaning: 'Reopening would put you over the active-project limit.',
      fix: 'Complete or delete another project first, or upgrade.',
    },
  ],
  whatHappensNext: [
    'Once there is room, the blocked action works straight away. Nothing needs to be re-enabled.',
    'If you upgrade, the new limits apply as soon as the plan is active.',
  ],
  related: ['change-or-cancel-plan', 'trial-and-subscribing', 'invite-team-and-roles'],
  updated: '2026-10-29',
}
