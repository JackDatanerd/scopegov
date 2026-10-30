// lib/help/articles/read-your-dashboard.ts
// Checked against the product code on 2026-10-29: app/(app)/dashboard/page.tsx (cards, register, in-progress list, activity log,
// visibility scoping, banners), lib/utils/attention.ts (every rule and reason string, APPROVAL_STALL_DAYS, MANUAL_PAUSE_ATTENTION_DAYS),
// lib/utils/project-status.ts (IN_PROGRESS_STATUSES), components/settings/SettingsClient.tsx (Guardian tab: Proactive risk alerts).
// If a reason string in attention.ts changes, update the step 2 bullets.

import type { HelpArticle } from '../types'

export const readYourDashboard: HelpArticle = {
  slug: 'read-your-dashboard',
  title: 'Reading your dashboard: what \u201cNeeds attention\u201d means and what to do about each item',
  summary: 'Understand the four cards, the Attention register and the activity log, and know the next step for every open matter.',
  category: 'getting-started',
  order: 6,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'The dashboard answers one question: what needs me today? The **Attention register** lists every project with something waiting on you, with one line saying what. ' +
    'Click the project, do the thing the line names, and it drops off the list by itself. Everything else on the page is context.',
  steps: [
    {
      title: 'Read the four cards',
      minutes: 1,
      body: 'Across the top:',
      details: [
        '**In progress**: projects that are **Active**, **Awaiting Signature**, **Intake**, **Changes Requested** or **Stalled**. The small line shows how many projects exist in total.',
        '**Needs attention**: how many projects have an open matter. It turns red above zero. It counts projects, not individual matters.',
        '**Active contract value**: the total of in-progress projects. If you bill in more than one currency, each is shown separately. It shows \u201c\u2014\u201d without the View Financials permission.',
        '**Subscription**: your plan and the days left on a trial, or \u201cRead-only \u2014 choose a plan\u201d if the workspace has lapsed.',
      ],
    },
    {
      title: 'Work the Attention register',
      minutes: 5,
      body: 'Each row shows the project, one **Open matter** and its status. Click the row to open the project. The matter is one of these:',
      details: [
        '**N open scope flags**: Guardian found out-of-scope requests. Resolve each, absorb it with an exception, or turn it into a change order.',
        '**N Guardian flags awaiting your review**: borderline calls that need a human decision.',
        '**Change order declined**, **Counter offer received**, **Change order stalled**: the client answered or went quiet. Handle the reply, or click **Remind** (it reads **Try again** on a stalled one).',
        '**Change order link expired \u2014 revise and resend**, **SOW link expired \u2014 reopen and resend**: the signing link has run out. Start a new version and send it again.',
        '**Client requested SOW changes**, **Client declined SOW**: revise the SOW, or talk to the client first.',
        '**SOW unsigned \u2014 project stalled**: the SOW has been out for 7 days unsigned. Remind the client, or withdraw and revise.',
        '**Paused for N days**: someone paused the project and it has been paused for a while. Click **Resume** if the work has restarted.',
        '**Approval pending \u2014 stuck awaiting a decision**: a document has waited 2 days or more on an approver. Nudge or reassign.',
        '**Approved but not sent \u2014 needs a retry**: approval cleared but the send failed. Click **Retry send**; nobody needs to approve again.',
        '**High-value project \u2014 no signed SOW**: a Draft or Intake project above your value threshold has no signed SOW. Get one signed before work starts.',
      ],
      watchFor: 'A project shows only its most important matter. When you fix it, the next one behind it can appear. That is normal.',
    },
    {
      title: 'Tune the high-value alert',
      minutes: 1,
      body: 'The last alert is the only one you control. Open [Settings \u2192 Guardian](/settings?tab=guardian) and find **Proactive risk alerts**. You can turn it off or set the **Contract value threshold**. The default is 10,000 in your workspace currency.',
      details: [
        'It only applies to Draft and Intake projects, and only in your workspace currency.',
        'It stops as soon as a SOW is signed.',
      ],
    },
    {
      title: 'Check the in-progress list',
      body: 'Below the register, the **In progress** table lists up to 8 projects, most recently updated first. The **Contract value** column needs View Financials, and retainers show their monthly fee. **All projects \u2192** opens the full list.',
    },
    {
      title: 'Glance at the activity log',
      body: 'The **Activity log** on the right shows the latest 14 events on your projects, such as SOWs signed, documents sent, and approvals. Routine background events are left out.',
    },
    {
      title: 'Know why yours might look different',
      body: 'The dashboard shows what your role lets you see.',
      details: [
        'Without **View All Projects** you see only projects you have been added to. If you have none you see an empty dashboard that says \u201cYour governance record starts here\u201d.',
        'Without **View Financials** values are hidden.',
        'The **New project** button needs **Create Projects**.',
        'On a trial with 5 days or fewer left, a banner offers **Upgrade now**. Trial workspaces also show people who can manage billing a link to the plan calculator.',
      ],
    },
  ],
  dos: [
    'Clear the Attention register at the start of your day.',
    'Click through to the project rather than guessing from the row.',
    'Resume or complete projects you are no longer pausing.',
    'Raise the value threshold if the high-value alert does not fit how you work.',
  ],
  donts: [
    'Do not ignore \u201cSOW unsigned\u201d. Work started without a signed SOW is the exact risk ScopeGov exists to prevent.',
    'Do not leave projects paused indefinitely. They return to the register after 14 days.',
    'Do not read the number as individual issues. It counts projects.',
    'Do not turn off the high-value alert without another way to catch unsigned large projects.',
  ],
  problems: [
    {
      symptom: 'The count says more than the six rows I can see',
      meaning: 'The dashboard lists the first six.',
      fix: 'Click the **View all** link beside **Attention register** to see every one on the Projects page.',
    },
    {
      symptom: 'A project I paused is not on the register',
      meaning: 'Pauses made on purpose are not flagged for the first 14 days.',
      fix: 'Nothing to do. After 14 days it shows as **Paused for N days**.',
    },
    {
      symptom: 'I fixed the matter but the project is still listed',
      meaning: 'There is another matter behind it, or the page has not refreshed.',
      fix: 'Refresh, then open the project and look at its flags, change orders and SOW status.',
    },
    {
      symptom: 'I see \u201cHigh-value project \u2014 no signed SOW\u201d on a project I am not worried about',
      meaning: 'The contract value is above your threshold and no SOW is signed yet.',
      fix: 'Get the SOW signed, or raise the threshold under **Proactive risk alerts**.',
    },
    {
      symptom: 'My dashboard is empty but projects exist',
      meaning: 'You only see projects you have been added to.',
      fix: 'Ask someone with Assign Team Members to add you, or ask an admin for View All Projects.',
    },
  ],
  whatHappensNext: [
    'The register updates as soon as the underlying matter is settled. There is nothing to dismiss.',
    'The same list is available as a filter on the Projects page, so you can return to it later.',
    'If something is waiting that you cannot act on, tell the person who can.',
  ],
  related: [
    'understand-flag-statuses', 'flag-to-change-order', 'client-counters-co', 'client-changes-decline-or-silence-sow',
    'send-waiting-on-approval', 'complete-archive-reopen-project', 'permissions-decoder',
  ],
  updated: '2026-10-29',
}
