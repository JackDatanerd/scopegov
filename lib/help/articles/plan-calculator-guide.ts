// lib/help/articles/plan-calculator-guide.ts
// Checked against the product code on 2026-10-29: app/(app)/plan-calculator/page.tsx (who may open it, when workspace figures are loaded),
// components/calculator/PlanCalculator.tsx (every input, the "How the number is built" card, plans table, assumptions), lib/billing/roi-model.ts
// (DEFAULT_RECOVERY_RATE 68%, default creep 10%), lib/billing/entitlements.ts (FEATURE_NEEDS), and the entry links in SettingsClient, the dashboard and LapsedBanner.
// If the model or its defaults change, update steps 3 and 4.

import type { HelpArticle } from '../types'

export const planCalculatorGuide: HelpArticle = {
  slug: 'plan-calculator-guide',
  title: 'How does the plan calculator work, and can I trust its number?',
  summary: 'Use your own figures to estimate what scope creep costs you and which plan would pay for itself, and see how every number is built.',
  category: 'billing-plans',
  order: 5,
  audience: { permissions: ['MANAGE_BILLING'], plan: 'all' },
  shortAnswer:
    'The plan calculator estimates how much work you give away each year, how much of it a plan could win back through change orders, and which is the smallest plan that fits you. ' +
    'Every figure is editable and every assumption is listed. It is an estimate from your numbers, not a forecast, and it tells you plainly if a plan would not pay for itself.',
  steps: [
    {
      title: 'Open it',
      minutes: 1,
      body: 'Go to [Plan calculator](/plan-calculator). You can reach it from the **Billing** tab (\u201cSee what scope creep is costing you\u2026\u201d), from the dashboard note \u201cWondering which plan fits?\u201d, and from the read-only banner.',
      details: [
        'You need **Manage Billing** or **View Financials**. It still works on a read-only workspace.',
        'Your workspace\u2019s own figures are filled in only if you hold **View All Projects** and **View Financials**. Otherwise you get the manual calculator.',
      ],
    },
    {
      title: 'Read what we measured',
      minutes: 2,
      body: 'If your figures are available, the first card is **From your workspace**. It shows what ScopeGov recorded over the last 12 months, or since you started if that is shorter.',
      details: [
        'Work granted free (exceptions), and what you already recovered through change orders.',
        'Scope flags raised, and how many became accepted change orders.',
        'Projects started, projects active now and team members.',
      ],
      watchFor: 'A young workspace has little history, so you will see a warning, and you can choose to project a year from your recent pace. Projection scales projects per year and free work only, not project value or recovery rate.',
    },
    {
      title: 'Check and adjust the inputs',
      minutes: 4,
      body: 'Every box is editable. Under **Your work**, **What you expect to win back** and **What you need from a plan**:',
      details: [
        '**Projects per year** and **Average project value**, and your **Currency**. If it is not US dollars, enter the rate (\u201c1 [currency] = how many USD?\u201d) because plans are priced in USD.',
        '**Scope creep, as a % of project value**: your honest estimate of work done outside the contract. 10% is a cautious starting guess.',
        '**Work you know you gave away free (per year)**, if you track it.',
        '**Share of leaked value you expect to recover (%)**: 68% is only a starting point. It is yours to set.',
        '**People who need a seat** and **Projects active at once**.',
        'Tick any you need: **Custom roles & permissions**, **Multi-step approval chains**, **Webhooks, Zapier & API keys**, **Portfolio view**, **Audit-log export**. Then choose monthly or annual billing.',
      ],
    },
    {
      title: 'See how the number is built',
      minutes: 3,
      body: 'The card **How the number is built** shows each step, so you can check the maths:',
      details: [
        '**Scope creep, your estimate** = projects per year \u00d7 average value \u00d7 creep %.',
        '**Leaked per year** = the larger of that estimate and the work you know you gave away free. They are never added together.',
        '**Recoverable per year** = leaked \u00d7 your recovery %.',
        'The recommended plan is the smallest one that fits your seats, active projects and ticked features. **Plans compared** lists each plan with its yearly price in USD, whether it fits you, and the estimated net.',
      ],
    },
    {
      title: 'Read the verdict honestly',
      body: 'If a plan costs more than you would recover, the calculator says so and suggests you may not need one yet.',
      details: [
        'Raise the creep or recovery percentage only if you truly believe it. The point is a fair test.',
        'The assumptions at the bottom list what the estimate leaves out: taxes and payment fees are not included, and nothing is guaranteed.',
      ],
    },
  ],
  dos: [
    'Use your real numbers, and keep the creep estimate cautious.',
    'Change one input at a time to see which one moves the answer.',
    'Tick only the features you will actually use.',
    'Re-run it after a quarter of real data.',
  ],
  donts: [
    'Do not treat the result as a promise of savings. It is an estimate.',
    'Do not add granted-free work on top of the creep estimate. The calculator already takes the larger.',
    'Do not forget the exchange rate if you bill in another currency.',
    'Do not pick a plan only because it shows a positive net. Check the seats and projects fit.',
  ],
  problems: [
    {
      symptom: 'The page says I need billing or financial access',
      meaning: 'It needs **Manage Billing** or **View Financials**.',
      fix: 'Ask an admin to open it for you, or to add one of those permissions.',
    },
    {
      symptom: 'My workspace numbers are not filled in',
      meaning: 'They are loaded only for people with **View All Projects** and **View Financials**. A failed load also falls back to manual.',
      fix: 'Ask someone who has both, or type your own figures.',
    },
    {
      symptom: 'It says a plan costs more than I would recover',
      meaning: 'At your numbers, the smallest fitting plan does not pay for itself yet.',
      fix: 'Check your creep estimate honestly. If it is right, you may not need a paid plan yet.',
    },
    {
      symptom: 'The net is blank',
      meaning: 'Your figures are in another currency and plans are priced in USD.',
      fix: 'Enter today\u2019s exchange rate in the box on the left.',
    },
    {
      symptom: 'A warning says the figures may be slightly low',
      meaning: 'Your workspace has more records than one summary reads.',
      fix: 'Treat the measured numbers as a minimum, and adjust the inputs yourself.',
    },
  ],
  whatHappensNext: [
    'Nothing is saved or changed. The calculator is read-only, so you can experiment freely.',
    'When you are ready, choose a plan on the **Billing** tab. See \u201cHow do I switch plans, update my card, cancel or resume?\u201d.',
  ],
  related: ['trial-and-subscribing', 'plan-limits', 'change-or-cancel-plan', 'read-your-reports'],
  updated: '2026-10-29',
}
