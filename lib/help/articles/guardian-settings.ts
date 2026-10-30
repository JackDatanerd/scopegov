// lib/help/articles/guardian-settings.ts
// Checked against the product code on 2026-10-29: components/settings/SettingsClient.tsx (GuardianTab), lib/ai/guardian.ts (THRESHOLDS and
// interpretClassifierOutput, the decision flow), app/api/guardian/{check,inbound}/route.ts + lib/ai/guardian-pipeline.ts (all three paths read the
// workspace tier), app/api/workspace/settings/route.ts (validation, Manage Workspace Settings, audit event), lib/utils/attention.ts (the alert).
// If THRESHOLDS change, update step 2.

import type { HelpArticle } from '../types'

export const guardianSettings: HelpArticle = {
  slug: 'guardian-settings',
  title: 'Guardian settings: choosing a sensitivity tier and the high-value alert',
  summary: 'Decide how readily Guardian flags a request, understand what each tier changes, and set the alert for large projects with no signed SOW.',
  category: 'guardian',
  order: 7,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'all' },
  shortAnswer:
    'Two settings in [Settings \u2192 Guardian](/settings?tab=guardian) shape what Guardian does. **Sensitivity tier** decides how sure Guardian must be before it flags a request: Conservative flags only strong cases, Medium is balanced, and Aggressive flags earlier and sends you more borderline calls. ' +
    '**Proactive risk alerts** warn you about large projects with no signed SOW. Changes apply to future checks only.',
  steps: [
    {
      title: 'Open the settings',
      minutes: 1,
      body: 'Go to [Settings \u2192 Guardian](/settings?tab=guardian). You need **Manage Workspace Settings**; without it the tab is restricted. The settings apply to the whole workspace, not to one project.',
    },
    {
      title: 'Understand what the tier changes',
      minutes: 3,
      body: 'For each client message Guardian judges two things: how well it matches your SOW, and how likely it is to be scope creep.',
      details: [
        'If the request clearly matches your SOW (85% confidence or more) it is in scope, or covered by a change order. The tier does not change this.',
        'Otherwise the tier sets two lines for how likely it is to be creep. At or above the first line it is flagged. Between the two lines it goes to you as a borderline call. Below the second line it is treated as in scope.',
        '**Conservative:** flagged from 92%, borderline from 75%.',
        '**Medium (default):** flagged from 85%, borderline from 60%.',
        '**Aggressive:** flagged from 78%, borderline from 55%.',
        'If Guardian is confident the request is both covered and creep, it is always sent to you as borderline.',
      ],
    },
    {
      title: 'Pick a tier',
      body: 'Start on Medium and change it only if the flags give you a reason.',
      details: [
        'Choose **Conservative** if you are flooded with flags that turn out to be fine, for example clients who ask many clarifying questions.',
        'Choose **Aggressive** if scope has slipped before and you would rather review more borderline calls than miss one, such as on tight fixed-fee work or with new clients.',
        'The trade-off is workload: Aggressive creates more **Awaiting your review** items, and Conservative can let subtle creep through.',
      ],
      watchFor: 'Wording in the SOW matters as much as the tier. Clear, specific **Deliverables** and **Out of scope** lines give Guardian more to match against.',
    },
    {
      title: 'Save and know what it affects',
      minutes: 1,
      body: 'Click **Save settings**. The new tier applies to checks from now on, whether you paste a message or forward an email.',
      details: [
        'Flags that already exist are not changed.',
        'The change is recorded in the workspace audit log.',
      ],
    },
    {
      title: 'Set the high-value alert',
      minutes: 2,
      body: 'Under **Proactive risk alerts**, switch it on or off. When it is on, set the **Contract value threshold**.',
      details: [
        'It flags a Draft or Intake project whose value is above the threshold and that has no signed SOW. The default is 10,000.',
        'The threshold is in your workspace currency. Projects billed in another currency are not compared.',
        'It shows on the dashboard as \u201cHigh-value project \u2014 no signed SOW\u201d, and stops once a SOW is signed.',
        'The threshold box appears only while the alert is on.',
      ],
    },
    {
      title: 'Check how it is working after a few weeks',
      body: 'Look at the flags you resolved or dismissed. If most were noise, move down a tier. If you spotted creep Guardian never raised, move up.',
    },
  ],
  dos: [
    'Change one thing at a time so you can see its effect.',
    'Write specific Deliverables and Out of scope lines in every SOW.',
    'Set the value threshold at the size where an unsigned SOW would really worry you.',
    'Tell the team when you change the tier, so a change in flag volume is expected.',
  ],
  donts: [
    'Do not go Aggressive without capacity to review the extra borderline calls.',
    'Do not go Conservative to avoid doing the review work. It trades noise for missed creep.',
    'Do not expect a change to rewrite flags that already exist.',
    'Do not turn the alert off without another way to catch large unsigned projects.',
  ],
  problems: [
    {
      symptom: 'I changed the tier but old flags did not change',
      meaning: 'The tier only affects checks made after you save.',
      fix: 'Nothing to do. Resolve existing flags as usual.',
    },
    {
      symptom: 'The Guardian tab is restricted',
      meaning: 'Your role does not include Manage Workspace Settings.',
      fix: 'Ask an admin to change the setting, or to add the permission.',
    },
    {
      symptom: 'I still get too many borderline flags',
      meaning: 'Borderline calls come from the middle band, and the SOW may be vague on the matter.',
      fix: 'Move to Conservative, and tighten the SOW\u2019s Deliverables and Out of scope wording for the next project.',
    },
    {
      symptom: 'There is no threshold box',
      meaning: 'It only appears when **Proactive risk alerts** is switched on.',
      fix: 'Turn the switch on, set the amount, then click **Save settings**.',
    },
    {
      symptom: 'A big project in another currency is not alerting',
      meaning: 'The alert compares only projects billed in your workspace currency.',
      fix: 'Watch those projects on the dashboard yourself, or get the SOW signed before work starts.',
    },
  ],
  whatHappensNext: [
    'Every new check, pasted or forwarded, uses the new tier from the next message.',
    'The alert appears on the dashboard\u2019s Attention register within moments of the project qualifying.',
    'Changes are in the audit log with who made them.',
  ],
  related: ['what-guardian-does', 'check-client-message-verdict', 'understand-flag-statuses', 'guardian-good-bad-inputs', 'read-your-dashboard'],
  updated: '2026-10-29',
}
