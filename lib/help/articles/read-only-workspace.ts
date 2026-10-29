// lib/help/articles/read-only-workspace.ts
// Behaviour checked against the product code on 2026-10-29: lib/billing/plans.ts (isWorkspaceLapsed, LAPSED_KEEP_PERMISSIONS,
// SETTLEMENT_PERMISSIONS, GRACE_DAYS), lib/auth/session.ts (hasSettlementPermission and its comment), lib/billing/entitlements.ts
// (READ_ONLY_FEATURES), components/layout/LapsedBanner.tsx, components/settings/SettingsClient.tsx (Billing tab, over-limit confirm),
// app/api/billing/upgrade/route.ts, app/api/workspace/delete/route.ts.

import type { HelpArticle } from '../types'

export const readOnlyWorkspace: HelpArticle = {
  slug: 'read-only-workspace',
  title: 'My workspace says it is read-only: what can I still do, and how do I restore it?',
  summary: 'Understand why a workspace goes read-only, what keeps working, what stops, and how to switch everything back on.',
  category: 'billing-plans',
  order: 3,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'A workspace becomes read-only when the trial or subscription has ended, or a failed payment was not fixed in time. Your data is safe. You can still view and export everything, and wind down documents that already exist, but you cannot create or send anything new. ' +
    'Someone with billing access restores it by choosing a plan.',
  steps: [
    {
      title: 'Recognise it',
      minutes: 1,
      body: 'A banner says **This workspace is read-only**. [Settings](/settings?tab=billing) \u2192 **Billing** shows \u201cRead-only since\u201d and the date.',
      details: [
        'The usual causes are a trial that ended without a plan, a subscription that has ended after a cancellation, or a failed payment that was not fixed within 5 days.',
      ],
    },
    {
      title: 'What still works',
      body: 'You keep everything that reads, and the actions that settle documents that already exist.',
      details: [
        'View all projects, documents, financials, client data and Guardian history.',
        'Export: invoice ledger CSV, the audit log, the Portfolio and reports, and PDF downloads.',
        'Billing and workspace settings, so you can fix the plan.',
        'Withdraw a SOW or change order, close a change order, accept a client\u2019s counter-offer, void an invoice, record or edit a payment, and resolve a dispute.',
        'Your clients can still open, sign or answer documents you already sent through their links.',
      ],
    },
    {
      title: 'What stops',
      body: 'Anything that creates or sends new work is switched off.',
      details: [
        'Creating projects, SOWs, change orders and invoices, and sending them.',
        'Inviting people, changing roles, and building approval workflows.',
        'Connecting integrations and using AI drafting.',
        'Guardian does not check new client emails while the workspace is read-only. Mail is kept and picked up after you subscribe.',
      ],
      watchFor: 'This affects every member at once. Members do not lose their roles. The permissions simply stop applying until the plan is back.',
    },
    {
      title: 'Restore it',
      minutes: 3,
      body: 'Someone with billing access clicks **Choose a plan** in the banner, or opens **Billing** and clicks **Subscribe** on a plan, then pays. Everything comes back as soon as the plan is active.',
      details: [
        'Members without billing access see \u201cAsk a workspace admin with billing access to choose a plan.\u201d',
        'If you have more members or projects than the plan allows, ScopeGov tells you exactly what is over and asks \u201cSubscribe anyway?\u201d. Your data stays intact and nobody is removed.',
        'After subscribing, deactivate members or complete projects to get back within the limits. Until you do, you cannot invite or add more.',
      ],
    },
    {
      title: 'Use the time well while you decide',
      body: 'Nothing is lost by waiting, so you can export, settle open documents and choose the plan calmly.',
      details: [
        'See \u201cHow do I get my data out before I cancel or leave?\u201d for the exports.',
        'Answer anything a client is waiting on by withdrawing or settling it.',
      ],
    },
  ],
  dos: [
    'Subscribe before the day if clients are mid-signature, to avoid a gap.',
    'Tell your team that read-only is a plan issue, not a permissions change.',
    'Use the read-only time to export what you need.',
    'Check **Payment history** to confirm a failed payment was resolved.',
  ],
  donts: [
    'Do not assume read-only means your data is gone. It is kept.',
    'Do not wait for a client to complain before you restore the plan.',
    'Do not try to remove members to get under a limit. You cannot while read-only. Subscribe first.',
    'Do not start a new workspace to get around it. Your history stays in the old one.',
  ],
  problems: [
    {
      symptom: 'I cannot click **Choose a plan**',
      meaning: 'Your role does not include Manage Billing.',
      fix: 'Ask the workspace Owner or an admin with billing access.',
    },
    {
      symptom: 'My client signed after the workspace went read-only',
      meaning: 'That is allowed. Clients can still respond to documents you already sent.',
      fix: 'Nothing to do. You can see it, and settle anything that follows.',
    },
    {
      symptom: 'I subscribed but things are still locked',
      meaning: 'The plan can take a moment to confirm.',
      fix: 'Wait for \u201cPayment received \u2014 confirming your plan\u201d to finish, then refresh. If it stays locked, contact support@scopegov.app.',
    },
    {
      symptom: 'I need to delete the workspace instead',
      meaning: 'A workspace with signed documents, accepted or open change orders, recorded payments or unpaid invoices cannot be deleted.',
      fix: 'Cancel the subscription instead, or contact support@scopegov.app.',
    },
  ],
  whatHappensNext: [
    'When the plan is active, every permission applies again and your limits follow the new plan.',
    'Guardian resumes checking client emails, including the ones kept while you were read-only.',
    'If you choose not to subscribe, the workspace stays read-only. Your data is retained.',
  ],
  related: ['change-or-cancel-plan', 'plan-limits', 'trial-and-subscribing'],
  updated: '2026-10-29',
}
