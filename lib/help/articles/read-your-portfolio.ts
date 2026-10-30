// lib/help/articles/read-your-portfolio.ts
// Checked against the product code on 2026-10-29: app/(app)/portfolio/page.tsx (VIEW_PORTFOLIO gate, plan gate, read-only handling),
// components/portfolio/PortfolioDashboard.tsx (cards, By currency, trend chart, severity bars, lists, By project / By client, CSV/PDF),
// lib/reports/scope-health.ts (SEVERITY_MULTIPLIER 1.0 / 0.5 / 0.2, OPEN_FLAG_RISK_RATE 5%, what counts as at risk, stuck-document reasons),
// lib/reports/portfolio-data.ts (list caps, snapshot history). If the risk model constants change, update step 3.

import type { HelpArticle } from '../types'

export const readYourPortfolio: HelpArticle = {
  slug: 'read-your-portfolio',
  title: 'Reading the Portfolio view: scope risk across every project',
  summary: 'Understand each card, chart and list on Portfolio, how \u201ccontract value at risk\u201d is worked out, and where to start.',
  category: 'guardian',
  order: 8,
  audience: { permissions: ['VIEW_PORTFOLIO'], plan: 'pro' },
  shortAnswer:
    'Portfolio rolls up scope risk across every project in progress: open scope flags, contract value at risk, exceptions you have granted, and documents that are stuck. ' +
    'Start at the **Projects by risk** list, open the worst project, and clear its flags and stuck documents. The cards and chart show whether you are getting ahead or falling behind.',
  steps: [
    {
      title: 'Open it and check what you can see',
      minutes: 1,
      body: 'Click **Portfolio** in the sidebar. It needs the **View Portfolio** permission and the Pro plan or above (a trial includes it). A read-only workspace can still open it.',
      details: [
        'Without **View Financials**, every amount shows \u201c\u2014\u201d and the chart shows open flags instead of value.',
        'Rows link to their project only if you also have **View All Projects**.',
        'Only projects in progress count: Active, Awaiting Signature, Intake, Changes Requested and Stalled. Draft, Complete and Archived do not.',
      ],
    },
    {
      title: 'Set the period and export',
      minutes: 1,
      body: 'Choose **Last 30 days**, **Last 90 days**, **6 months**, **12 months** or **All time** at the top. The period shapes the chart and trend lines. Use **CSV** or **PDF** to export; the CSV lists every row that the page only shows a part of.',
    },
    {
      title: 'Read the four cards',
      minutes: 3,
      body: 'Each card is a live figure, with the change since the start of the period underneath.',
      details: [
        '**Open scope flags**: flags still unresolved, across every in-progress project and every currency.',
        '**Contract value at risk**: an estimate of money exposed. Each open flag puts 5% of its project\u2019s contract value at risk, scaled by severity (High 100%, Medium 50%, Low 20%) and never more than the whole contract. Exceptions granted on in-progress projects are added on top.',
        '**Exceptions granted**: work you chose to give free.',
        '**Stalled documents**: stalled SOWs and change orders, split as \u201cN SOW \u00b7 N CO\u201d.',
      ],
      watchFor: 'Borderline calls waiting for your review are not in the value at risk yet. They are unresolved but not confirmed creep. Clear them in the project.',
    },
    {
      title: 'Look at the chart and the breakdowns',
      minutes: 2,
      body: 'The chart plots contract value at risk (or open flags without View Financials) over time, from a daily snapshot. **Open flags by severity** shows how many are High, Medium and Low.',
      details: [
        'If you bill in more than one currency, a **By currency** table shows each one. The headline value is for your main currency only, because amounts are never converted.',
        'The chart is a record of days that have passed. A new workspace starts with only a few points.',
      ],
    },
    {
      title: 'Work the lists',
      minutes: 5,
      body: 'Below the cards:',
      details: [
        '**Open scope flags**: highest severity first. Filter by severity, and click a row to open the project.',
        '**Documents needing action**: SOWs and change orders that are stuck, each with a reason: **SOW unsigned**, **Stalled**, **Declined**, **Expired**, **Changes requested** or **Counter-offer**. It shows the oldest 100.',
        '**Exceptions granted, all-time**: the newest 25 exceptions, with the total value given away.',
        '**Projects by risk**: switch between **By project** and **By client**. Ranked by value at risk, or by high flags, then open flags, then stuck documents without View Financials.',
      ],
    },
    {
      title: 'Turn it into a routine',
      body: 'Once a week, open **Projects by risk**, take the top three, and clear their High flags and stuck documents. Check the cards for the trend. Then export the CSV if someone needs the detail.',
    },
  ],
  dos: [
    'Start from **Projects by risk**, not from the cards.',
    'Clear High flags first. They carry the most value at risk.',
    'Resolve borderline calls, so they stop sitting outside the numbers.',
    'Export the CSV for anything the page truncates.',
  ],
  donts: [
    'Do not treat value at risk as a forecast of loss. It is an estimate of exposure.',
    'Do not compare it across currencies. Use the **By currency** table.',
    'Do not expect Draft, Complete or Archived projects. They are not in progress.',
    'Do not leave exceptions granted without a note. They add to the risk value.',
  ],
  problems: [
    {
      symptom: 'The Portfolio page says I need a permission',
      meaning: 'It needs **View Portfolio**, because it rolls up risk across every project.',
      fix: 'Ask an admin to add it under [Team](/team) \u2192 **Roles**.',
    },
    {
      symptom: 'The page says it is included in a higher plan',
      meaning: 'Portfolio is part of Pro and above.',
      fix: 'Click **See plans**, or use Reports and the dashboard instead.',
    },
    {
      symptom: 'Value at risk looks too small',
      meaning: 'Each open flag only counts 5% of its project, scaled by severity and capped at the whole contract.',
      fix: 'That is how the estimate works. Look at **Open flags by severity** and the counts for the full picture.',
    },
    {
      symptom: 'Money shows a dash',
      meaning: 'Amounts are hidden without **View Financials**.',
      fix: 'Ask an admin for the permission. Counts still work.',
    },
    {
      symptom: 'A project I expected is missing',
      meaning: 'Only projects in progress count, and its flags may all be resolved.',
      fix: 'Check the project\u2019s status and its Guardian tab.',
    },
  ],
  whatHappensNext: [
    'The cards and lists are live and update as flags and documents change.',
    'The chart adds a point from the daily snapshot each day.',
    'The same flags and stuck documents also appear on each project and on the dashboard\u2019s Attention register.',
  ],
  related: ['read-your-dashboard', 'read-your-reports', 'understand-flag-statuses', 'guardian-settings', 'permissions-decoder'],
  updated: '2026-10-29',
}
