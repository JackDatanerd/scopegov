// lib/help/articles/change-or-cancel-plan.ts
// Labels and wording checked against the product code on 2026-10-29: components/settings/SettingsClient.tsx (BillingTab: Current plan,
// Update card, Cancel subscription, Resume subscription, Payment history, Available plans, confirm dialogs, failed-payment banner),
// app/api/billing/upgrade/route.ts (over-limit refusals), lib/billing/plans.ts (GRACE_DAYS = 5).

import type { HelpArticle } from '../types'

export const changeOrCancelPlan: HelpArticle = {
  slug: 'change-or-cancel-plan',
  title: 'How do I switch plans, update my card, cancel or resume?',
  summary: 'Change your plan or billing interval, fix a card, cancel and undo a cancellation, and know what each one costs you.',
  category: 'billing-plans',
  order: 2,
  audience: { permissions: ['MANAGE_BILLING'], plan: 'all' },
  shortAnswer:
    'Everything is on the **Billing** tab in [Settings](/settings?tab=billing). Switching plans starts a new subscription and charges you now, with no credit for unused time. ' +
    'Cancelling keeps access until the end of the paid period. **Resume subscription** undoes a cancellation before then.',
  beforeYouStart: [
    'The Manage Billing permission. The Owner has it. See [Team](/team) if you do not.',
    'A card for checkout. Payments are in US dollars.',
  ],
  steps: [
    {
      title: 'Open Billing',
      minutes: 1,
      body: 'Go to [Settings](/settings?tab=billing) \u2192 **Billing**. **Current plan** shows your plan, the date it **Renews** (or **Ends**), and the card on file. **Payment history** lists charges and billing events with their date and amount.',
    },
    {
      title: 'Switch plan or interval',
      minutes: 3,
      body: 'Under **Available plans**, choose **Monthly** or **Annual**, then click **Upgrade**, **Downgrade**, or **Switch to annual** or **Switch to monthly** on the plan you want.',
      details: [
        'A confirmation reminds you: \u201cSwitching plans starts a new subscription and charges you now.\u201d Your current subscription ends immediately and the time already paid for is not credited or refunded.',
        'A secure payment window opens. Enter your card and confirm.',
        'A switch to a smaller plan is refused while you have more active members or projects than it allows. Reduce first, then switch.',
      ],
      watchFor: 'Switch near the end of a billing period when you can, so you waste less paid time.',
    },
    {
      title: 'Update your card',
      minutes: 1,
      body: 'Click **Update card** under **Current plan** and follow the secure window. Your subscription and plan do not change.',
    },
    {
      title: 'Cancel',
      minutes: 1,
      body: 'Click **Cancel subscription** and confirm. You keep access until the end of the current billing period. After that the workspace becomes read-only, so you can still view and export everything.',
      details: [
        'Current plan then shows **Ends** with the date instead of **Renews**.',
        'Nothing is deleted. Your projects, documents and history stay.',
      ],
    },
    {
      title: 'Change your mind',
      minutes: 1,
      body: 'Before the end date, click **Resume subscription**. The cancellation is undone and your plan carries on as before.',
      watchFor: 'If you start a new plan while a cancellation is pending, the time you have already paid for until the end date is not credited. Use **Resume subscription** if you want to keep the current plan.',
    },
    {
      title: 'If a payment fails',
      minutes: 2,
      body: 'A banner says \u201cYour last payment failed. Update your payment method within N days or this workspace becomes read-only.\u201d You have 5 days.',
      details: [
        'Click **Retry with a new card**. It starts a new subscription on the same plan and charges the new card now.',
        'The failure and any downgrade for non-payment appear in **Payment history**.',
      ],
    },
  ],
  dos: [
    'Decide on seats and projects first, then pick the plan. See \u201cWhat do seats, active projects and AI drafts count?\u201d.',
    'Update your card before it expires.',
    'Keep **Payment history** for your records.',
    'Export what you need before cancelling if you are unsure. You can still export afterwards.',
  ],
  donts: [
    'Do not switch plans mid-period expecting a refund for the rest.',
    'Do not ignore the failed-payment banner. After 5 days the workspace goes read-only.',
    'Do not cancel just to change plan. Use the plan buttons instead.',
    'Do not assume cancelling deletes anything. It does not.',
  ],
  problems: [
    {
      symptom: 'The plan button says I am over the limit',
      meaning: 'You have more active members or projects than the smaller plan allows.',
      fix: 'Deactivate members on [Team](/team), or complete, archive or delete projects. Then switch.',
    },
    {
      symptom: 'The payment window does not open',
      meaning: 'An ad-blocker or privacy extension may be blocking the payment provider.',
      fix: 'Turn it off for this site, refresh and try again.',
    },
    {
      symptom: 'I see no **Billing** tab',
      meaning: 'Your role does not include Manage Billing.',
      fix: 'Ask the Owner, or an admin who can change roles.',
    },
    {
      symptom: 'I cancelled but I still have access',
      meaning: 'That is expected. Access continues until the end of the paid period.',
      fix: 'Nothing to do. If you change your mind, click **Resume subscription**.',
    },
  ],
  whatHappensNext: [
    'On a switch or card change the new details apply straight away.',
    'On cancel, the workspace becomes read-only on the date shown under **Ends**. See \u201cMy workspace is read-only\u201d for what that means.',
    'On a failed payment that is not fixed in time, the workspace becomes read-only until you subscribe.',
  ],
  related: ['plan-limits', 'read-only-workspace', 'trial-and-subscribing'],
  updated: '2026-10-29',
}
