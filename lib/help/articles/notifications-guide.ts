// lib/help/articles/notifications-guide.ts
// Checked against the product code on 2026-10-29: components/notifications/NotificationsClient.tsx (page controls), components/layout/NotificationBell.tsx,
// components/settings/SettingsClient.tsx (NOTIF_ITEMS, IN_APP_NOTIF_ITEMS, Notifications tab, WorkspaceNotificationDefaultsSection, "required by your
// workspace admin"), lib/utils/notify.ts + the notifyMembersWithPermission call sites (which permission receives which event),
// app/api/cron/notification-cleanup/route.ts (90 / 180 day retention). If events are added to NOTIF_ITEMS, update step 2.

import type { HelpArticle } from '../types'

export const notificationsGuide: HelpArticle = {
  slug: 'notifications-guide',
  title: 'Notifications: why you did or did not get one, and how to tune them',
  summary: 'Find your notifications, choose what reaches your inbox and the bell, and work out why one never arrived.',
  category: 'getting-started',
  order: 7,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'ScopeGov tells you about events through the bell and by email, and you choose both channels for each event in [Settings \u2192 Notifications](/settings?tab=notifications). ' +
    'Who is told depends on what you can do on that project: for example, only people who can send SOWs hear about a SOW being signed. ' +
    'If a notification never came, it is almost always muted, locked by an admin, or meant for a different role.',
  steps: [
    {
      title: 'Find your notifications',
      minutes: 1,
      body: 'Click the bell in the sidebar for the latest, or open [Notifications](/notifications) for all of them.',
      details: [
        'Clicking a notification opens the project or document it is about.',
        'The page has **All** and **Unread** tabs, **Mark all read** and **Clear read**.',
        'Read notifications are kept for 90 days. Anything older than 180 days is removed, even if never opened.',
      ],
    },
    {
      title: 'Choose what reaches you',
      minutes: 3,
      body: 'Open [Settings \u2192 Notifications](/settings?tab=notifications). Each event has an **Email** switch and a **Bell** switch. Turn either off to stop that channel for that event.',
      details: [
        '**SOWs:** signed, declined, changes requested, stalled (7+ days unsigned), and link expired.',
        '**Change orders:** accepted, declined, countered, stalled (5+ days without a reply), and link expired.',
        '**Guardian:** scope flag raised, scope flag stalled (5+ days), escalation, and comments on scope flags.',
        '**Money:** invoice sent, payment received, overdue, disputed, client says they paid, payment milestone overdue, and retainer term ended.',
        '**Approvals:** approval requested, your request approved or rejected, and approval stuck with no reachable approver.',
        '**People and projects:** added to or removed from a project, @-mentions in project discussion, teammate joined or left.',
        '**Other:** client opened a document, and trial ending (3, 2 and 1 days before).',
      ],
      watchFor: 'Several events are bell-only and listed separately under **In-app notifications**, such as mentions and teammates joining. They never send email.',
    },
    {
      title: 'Know who is told',
      body: 'An event goes to the people who hold the matching permission and can see that project, minus anyone who muted it.',
      details: [
        'SOW events: **Send Sow**. Change order events: **Send Change Orders**.',
        'Scope flags: **Approve Flags**.',
        'Invoice, payment and milestone events: **View Financials**.',
        'Approval requests go to the people assigned to that step, and the decision goes back to the person who sent the document.',
        '**Teammate joined** goes to people who can invite members. **Approval stuck** goes to people who manage workspace settings.',
      ],
    },
    {
      title: 'Admins: set and lock defaults',
      minutes: 2,
      body: 'With **Manage Workspace Settings**, scroll to **Workspace defaults** on the same tab. Set the default for each event, and tick **Lock** to stop individuals turning it off.',
      details: [
        'Defaults apply to new and existing members.',
        'Locking overrides any personal choice already made.',
        'A locked event shows \u201crequired by your workspace admin\u201d beside it, and its switches are greyed out.',
      ],
      watchFor: 'Lock only what is truly mandatory, such as flags and approvals. Too many locks and people stop reading any of it.',
    },
  ],
  dos: [
    'Keep **Email** on for the events you must act on, and use the bell for the rest.',
    'Mute events you will never act on rather than ignoring the emails.',
    'Lock the few events your process cannot afford to miss.',
    'Check spam or junk if an email you expected is missing.',
  ],
  donts: [
    'Do not mute everything. The Attention register on the dashboard is not a substitute for being told.',
    'Do not lock every event. It makes the inbox noisy for everyone.',
    'Do not expect notifications for projects you cannot see.',
    'Do not rely on the bell for something old. Unread items are dropped after 180 days.',
  ],
  problems: [
    {
      symptom: 'I never get the email when a client signs',
      meaning: 'SOW events only go to people with **Send Sow** who can see that project. You may also have muted it.',
      fix: 'Check **SOW signed by client** in your settings, then ask an admin to confirm your role and your access to the project.',
    },
    {
      symptom: 'I get no invoice or payment notifications',
      meaning: 'Those events go to people with **View Financials**.',
      fix: 'Ask an admin to add that permission to your role.',
    },
    {
      symptom: 'A switch is greyed out and says \u201crequired by your workspace admin\u201d',
      meaning: 'An admin locked that event for everyone.',
      fix: 'Ask the admin if you need it off. Only they can unlock it.',
    },
    {
      symptom: 'I am getting too many emails',
      meaning: 'Every event is on by default.',
      fix: 'Turn **Email** off for the events you do not act on. Leave **Bell** on if you still want them in the app.',
    },
    {
      symptom: 'An old notification has disappeared',
      meaning: 'Read ones are removed after 90 days, and everything after 180.',
      fix: 'Open the project. Its documents, flags and statuses show where things stand now.',
    },
  ],
  whatHappensNext: [
    'Your changes apply from the next event. Past notifications are not changed.',
    'If an admin changes a lock, it replaces your choice for that event straight away.',
    'Events that need action also show on the dashboard\u2019s Attention register until they are settled.',
  ],
  related: ['read-your-dashboard', 'permissions-decoder', 'understand-flag-statuses', 'send-waiting-on-approval'],
  updated: '2026-10-29',
}
