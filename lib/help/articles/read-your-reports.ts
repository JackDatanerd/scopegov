// lib/help/articles/read-your-reports.ts
// Checked against the product code on 2026-10-29: app/(app)/reports/page.tsx (tabs, period and currency controls, cards, tables, CSV/PDF export),
// app/api/reports/route.ts (VIEW_ALL_PROJECTS; VIEW_FINANCIALS for the financial mode), lib/reports/scope-financial-data.ts (classifyFlag, recovered value,
// recovery rate inputs, Draft/Archived exclusion, retainer-renewal exclusion, CO grid). If a card is added or renamed, update steps 2 and 3.

import type { HelpArticle } from '../types'

export const readYourReports: HelpArticle = {
  slug: 'read-your-reports',
  title: 'Reading your reports: what the scope and financial numbers mean',
  summary: 'Understand every card and table on the Reports page, so you can tell whether Guardian and your change orders are paying off.',
  category: 'getting-started',
  order: 8,
  audience: { permissions: ['VIEW_ALL_PROJECTS', 'VIEW_FINANCIALS'], plan: 'all' },
  shortAnswer:
    'Reports has two views. **Scope protection** shows how many out-of-scope requests were flagged, how many became paid change orders, and how much work was given free. ' +
    '**Financial overview** shows your contract value and how change orders are performing. Both cover one period and one currency at a time, and both can be exported.',
  steps: [
    {
      title: 'Choose the view, period and currency',
      minutes: 1,
      body: 'Open [Reports](/reports). Pick **Scope protection** or **Financial overview**, then set the period.',
      details: [
        'Periods are **Last 30 days**, **Last 90 days** (the default), **6 months**, **12 months** and **All time**.',
        'A currency picker appears only if you have projects in more than one currency. Amounts are never converted, so each currency is its own report.',
        'You need **View All Projects** to see Reports at all, and **View Financials** for the **Financial overview** and for any amount.',
      ],
    },
    {
      title: 'Read the Scope protection cards',
      minutes: 3,
      body: 'The four cards tell the main story:',
      details: [
        '**Flags raised**: scope flags created in the period. It leaves out flags you dismissed as not out of scope, and flags still waiting for your review.',
        '**Converted to CO**: flags that became a change order, whether it is accepted yet or not.',
        '**Recovery rate**: converted flags divided by flags raised.',
        '**Recovered value**: the value of the change orders accepted in the period. Retainer renewals that only replace the monthly fee are not counted as extra value. It shows \u201c\u2014\u201d without View Financials.',
      ],
      watchFor: 'A low recovery rate is not always a problem. Flags you closed with an exception, or have not actioned yet, are still counted as raised.',
    },
    {
      title: 'Read the scope tables',
      minutes: 3,
      body: 'Below the cards:',
      details: [
        '**Flags by project**: which projects attract the most flags. It shows the top 10; export for all.',
        '**Exceptions granted**: work you chose to do free, with its estimated value (value needs View Financials).',
        '**Flag outcome grid**: **Raised**, **Converted to CO**, **Closed (no CO)**, **Still open** and **Pending review**. The first one is the sum of the next three. **Pending review** is shown separately because those flags have not been decided yet.',
        '**Scope adjustments**: changes made to a project\u2019s deliverables, with the reason and date. It shows 10; export for all.',
      ],
    },
    {
      title: 'Read the Financial overview',
      minutes: 3,
      body: 'This view needs **View Financials**.',
      details: [
        '**Portfolio contract value**: base contract value plus all accepted change orders. Draft and archived projects are left out.',
        '**Change orders added**: the value of change orders accepted in the period.',
        '**COs sent** and **CO acceptance rate**: change orders sent in the period, and the share of them accepted.',
        '**Contract value by client** and **by project type**: where your value sits.',
        '**Change order impact grid**: **Sent**, **Accepted**, **Declined**, **Pending** and **Closed / expired**. A revised change order is counted once, not once per version.',
      ],
    },
    {
      title: 'Export what you see',
      minutes: 1,
      body: 'Click **CSV** or **PDF** at the top. The export matches the view, period and currency you have selected, and includes every row, not just the top lists.',
      details: [
        'Exports still work after a subscription ends. The workspace becomes read-only, but it stays readable.',
        'The financial export needs View Financials.',
      ],
    },
  ],
  dos: [
    'Read the **Flag outcome grid** before the recovery rate. It shows where the flags went.',
    'Compare the same period each month so the trend means something.',
    'Check **Exceptions granted** for work that could have been a change order.',
    'Export before a client review or a pricing change.',
  ],
  donts: [
    'Do not compare numbers across currencies. Each currency is separate.',
    'Do not read a low recovery rate as failure without checking the outcome grid.',
    'Do not expect draft or archived projects in the portfolio value.',
    'Do not share the financial export beyond people who may see prices.',
  ],
  problems: [
    {
      symptom: 'There is no Reports page, or it says I am missing a permission',
      meaning: 'Reports needs **View All Projects**. The Financial overview also needs **View Financials**.',
      fix: 'Ask an admin to add the permission to your role.',
    },
    {
      symptom: 'Recovered value shows a dash',
      meaning: 'Amounts are hidden without **View Financials**.',
      fix: 'Ask an admin for the permission, or ask someone who has it to read the number.',
    },
    {
      symptom: 'My recovery rate is lower than I expected',
      meaning: 'Flags closed with an exception, closed manually, or still open all count as raised but not converted.',
      fix: 'Check the **Flag outcome grid** to see which bucket they are in.',
    },
    {
      symptom: 'Some projects seem to be missing',
      meaning: 'The report covers one currency, and the financial lists leave out draft and archived projects.',
      fix: 'Use the currency picker, and check the project\u2019s status.',
    },
    {
      symptom: 'Pending review flags are not in Raised',
      meaning: 'They have not been decided yet, so they are counted once you decide them.',
      fix: 'Resolve the borderline flags on the project, then reload the report.',
    },
  ],
  whatHappensNext: [
    'The numbers update as flags are resolved and change orders are accepted. There is nothing to refresh manually beyond reloading.',
    'The same events appear on the dashboard\u2019s activity log and in the audit log as they happen.',
    'Use what you learn to tune Guardian\u2019s sensitivity or to tighten the wording of your next SOW.',
  ],
  related: ['read-your-dashboard', 'understand-flag-statuses', 'flag-to-change-order', 'guardian-settings', 'export-before-you-leave'],
  updated: '2026-10-29',
}
