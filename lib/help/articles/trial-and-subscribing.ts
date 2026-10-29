// lib/help/articles/trial-and-subscribing.ts
// Numbers come from lib/billing/entitlements.ts and plans.ts. Labels checked against SettingsClient BillingTab,
// Sidebar, LapsedBanner, trial-warning and payment-overdue crons, guardian/inbound on 2026-10-29.

import type { HelpArticle } from '../types'

export const trialAndSubscribing: HelpArticle = {
  slug: 'trial-and-subscribing',
  title: 'Understanding your trial: what you get, what happens on day 14, how to subscribe',
  summary: 'See what the trial includes, what changes when it ends, and how to keep working without a gap.',
  category: 'getting-started',
  order: 5,
  audience: { permissions: ['MANAGE_BILLING'], plan: 'all' },
  shortAnswer:
    'Your 14-day trial includes every feature, 10 seats and unlimited projects. If it ends without a plan, the workspace becomes read-only: nothing is deleted, but you cannot create or send new documents until you subscribe. ' +
    'To subscribe, open Settings, go to **Billing**, pick a plan and pay.',
  beforeYouStart: [
    'A card for the checkout. Payments are processed in US dollars.',
    'The permission to manage billing. The Owner has it, and the default Account Manager role does not.',
    'The seats and projects you actually use, so you pick a plan that fits.',
  ],
  steps: [
    {
      title: 'See how long is left',
      minutes: 1,
      body: 'The sidebar shows the days remaining. [Settings](/settings?tab=billing) \u2192 **Billing** shows the same under **Current plan**.',
    },
    {
      title: 'Compare plans',
      minutes: 4,
      body: 'On **Billing**, scroll to **Available plans**. Switch between **Monthly** and **Annual** (annual is priced at two months free) and compare each card.',
      details: [
        'Solo: $39 a month, 1 seat, 3 active projects.',
        'Starter: $99 a month, 3 seats, 8 active projects, webhooks, Zapier and API keys.',
        'Pro: $249 a month, 5 seats, unlimited projects, custom roles, Portfolio, Slack, HubSpot and Google Drive.',
        'Agency: $399 a month, 10 seats, adds audit-log export and the most AI drafts.',
        'The cards list seats, projects, approvals, integrations and AI drafts a month, so use them as the source of truth.',
      ],
      watchFor: 'If you have more active members or projects than a plan allows, the card tells you. Reduce first, then switch. A read-only workspace can subscribe first and reduce afterwards.',
    },
    {
      title: 'Subscribe',
      minutes: 3,
      body: 'Click **Upgrade** on the plan you want (it reads **Subscribe** once the trial is over). A secure payment window opens. Enter your card and confirm.',
      details: [
        'You see \u201cPayment received \u2014 confirming your plan\u201d while it is confirmed. The page refreshes when the plan is active.',
        'If the payment window does not open, an ad-blocker may be blocking the payment provider. Disable it for this site and try again.',
      ],
    },
    {
      title: 'Check it worked',
      minutes: 1,
      body: 'Under **Current plan** you should see your plan name, **Renews** with a date, and the card on file. **Update card** and **Cancel subscription** are there if you need them.',
    },
  ],
  dos: [
    'Subscribe before day 14 if clients are mid-signature, so nothing pauses.',
    'Pick the plan by seats and projects first, then by features.',
    'Check **Payment history** for receipts.',
    'Export what you need before the trial ends if you are undecided. You can still export afterwards.',
  ],
  donts: [
    'Do not wait for the last day. The warning emails come at 3, 2 and 1 days before, then on the day it ends.',
    'Do not switch plans mid-period expecting credit. Switching starts a new subscription and the unused time is not credited or refunded.',
    'Do not assume read-only means deleted. Your data is kept.',
    'Do not ignore a failed-payment banner. You have a few days to update the card.',
  ],
  problems: [
    {
      symptom: 'A banner says \u201cThis workspace is read-only\u201d',
      meaning: 'The trial or subscription has ended. You can view and export everything, but not create or send new documents or invite people.',
      fix: 'Click **Choose a plan** and subscribe. Everything unlocks once the plan is active.',
    },
    {
      symptom: 'I cannot see **Billing**, or the plan buttons do nothing',
      meaning: 'You may not have the permission to manage billing, or subscription details failed to load.',
      fix: 'Ask the Owner, or use **Reload** on the banner if it says details could not be loaded.',
    },
    {
      symptom: 'A client is mid-signature and my trial has ended',
      meaning: 'Clients can still open, sign or answer documents you already sent. You can also still withdraw, void and record payments on existing documents.',
      fix: 'You only need to subscribe to start something new.',
    },
    {
      symptom: 'The card says I have more members or projects than the plan allows',
      meaning: 'The plan\u2019s seats or active-project limit is lower than what you use.',
      fix: 'Deactivate members on the [Team](/team) page or complete projects, then switch. Or pick a larger plan.',
    },
    {
      symptom: 'A banner says my last payment failed',
      meaning: 'The renewal charge did not go through and you are in a short grace period.',
      fix: 'Update your payment method before the days shown run out, or the workspace goes read-only.',
    },
  ],
  whatHappensNext: [
    'Once the plan is active, the workspace unlocks and your limits change to the new plan\u2019s.',
    'If you cancel, you keep access until the end of the paid period, then the workspace becomes read-only. **Resume subscription** undoes a cancellation before then.',
    'While read-only, Guardian does not check client emails. Mail is kept and picked up after you subscribe.',
  ],
  related: ['invite-team-and-roles', 'first-project'],
  updated: '2026-10-29',
}
