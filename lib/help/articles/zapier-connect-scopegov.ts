// lib/help/articles/zapier-connect-scopegov.ts
//
// Checked 2026-10-30 against: components/settings/IntegrationsSection.tsx (Zapier + API keys blocks), app/api/integrations/v1/* (me, hooks, hooks/[id], events/[type]/sample),
// lib/integrations/{zapier,event-catalog,events,api-keys,plans}.ts, integrations/zapier/{README.md,index.js,events.json}.
// NOTE: whether the ScopeGov app is listed in Zapier's public directory is decided outside this repo; the article gives a fallback that does not depend on it.

import type { HelpArticle } from '../types'

export const zapierConnectScopegov: HelpArticle = {
  slug: 'zapier-connect-scopegov',
  title: 'How do I connect ScopeGov to Zapier?',
  summary: 'Start a Zap whenever a SOW is signed, an invoice is paid or a scope flag is raised, with or without ScopeGov\u2019s Zapier app.',
  category: 'integrations-security',
  order: 5,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'starter' },
  shortAnswer:
    'Create an API key in [Settings](/settings) under **Integrations**, then add ScopeGov in Zapier, paste the key when asked, and pick a trigger such as **Invoice Paid**. Your Zap then runs every time that event happens. ' +
    'If ScopeGov does not show up in Zapier\u2019s app list for your account, use Zapier\u2019s own **Webhooks** trigger with a ScopeGov webhook instead.',
  beforeYouStart: [
    'The Starter, Pro or Agency plan, or an active trial.',
    'The Manage Workspace Settings permission to create the key, plus the permission behind each trigger you will use: Send SOWs, Send Change Orders, Approve Flags or View Financials. The key works with the creator\u2019s permissions.',
    'A Zapier account.',
  ],
  steps: [
    {
      title: 'Create an API key for Zapier',
      body: 'In **Integrations**, find **API keys**. Type a name such as \u201cZapier\u201d under **New key name**, click **Create key**, and copy the key from the box that appears.',
      details: [
        'The box is titled **API key \u2014 copy it now**, and the key is shown once. Click **I have saved it** only after you have pasted it somewhere safe.',
        'If asked, confirm it is you with your password or authenticator code.',
        'The details are in the article on API keys.',
      ],
    },
    {
      title: 'Add ScopeGov to a Zap',
      body: 'In Zapier, start a Zap, choose ScopeGov as the trigger app, and paste the API key when it asks you to connect an account.',
      details: [
        'The connection is checked straight away. It shows your agency name when it works.',
        'Pick a trigger. There is one for each ScopeGov event, with names such as **SOW Signed**, **Change Order Accepted**, **Scope Flag Raised**, **Invoice Paid**, **Invoice Overdue** and **Retainer Ending**.',
        'You can only pick triggers for events you could see in ScopeGov yourself.',
      ],
    },
    {
      title: 'Test the trigger and build the rest of the Zap',
      body: 'Zapier asks ScopeGov for sample data so you can map fields, such as the client, project and amount, into your next step.',
      details: [
        'The sample is example data, not one of your real records.',
        'Turn the Zap on in Zapier when you are ready.',
      ],
    },
    {
      title: 'See your Zaps in ScopeGov',
      body: 'Back in **Integrations**, the **Zapier** box lists every active Zap that uses a ScopeGov trigger, named \u201cZapier\u201d followed by the trigger.',
      details: [
        '**Turn off** and **Turn on** pause and resume one. **Remove** deletes it, and the Zap stops receiving events.',
        'Turning a Zap off in Zapier removes it from this list.',
        'A workspace can have up to 100 Zap triggers.',
      ],
    },
    {
      title: 'If ScopeGov is not in Zapier\u2019s app list',
      body: 'Use Zapier\u2019s **Webhooks by Zapier** trigger, **Catch Hook**, and copy the custom webhook address Zapier gives you. In ScopeGov, create a webhook with that address as the **Endpoint URL**.',
      details: [
        'The steps for creating the webhook are in the article on webhooks. Click **Send test** to give Zapier a sample.',
        'You pick the events yourself when you create the webhook, and a workspace can have 10 webhooks. Each can carry several events.',
        'ScopeGov still signs each message, but a Catch Hook does not check the signature, so keep that address secret.',
      ],
    },
  ],
  dos: [
    'Give the key a name that says what it is for.',
    'Create the key from an account that will stay in the workspace.',
    'Test each Zap with a real event before you rely on it.',
    'Remove Zaps you no longer use.',
  ],
  donts: [
    'Do not paste the API key anywhere except Zapier\u2019s connection screen.',
    'Do not create the key from an account that is about to leave the workspace.',
    'Do not expect Zaps to read or change your projects. They can only receive events.',
    'Do not forget a Zap that sends client or payment details to a third party.',
  ],
  problems: [
    {
      symptom: 'Zapier says the key is invalid, or cannot connect',
      meaning: 'The key was copied wrongly, has been revoked, or the workspace\u2019s plan no longer includes integrations.',
      fix: 'Create a new key, paste it again, and check your plan under **Billing**.',
    },
    {
      symptom: '\u201cThe person who created this API key no longer has the \u2026 permission needed for \u2026\u201d',
      meaning: 'Keys work with the permissions of whoever created them. That person lost the permission, or left the workspace.',
      fix: 'Ask someone who holds the permission to create a new key, connect Zapier with it, and revoke the old one.',
    },
    {
      symptom: '\u201cToo many active Zap triggers (limit 100). Turn some Zaps off.\u201d',
      meaning: 'The workspace has hit the cap.',
      fix: 'Remove Zaps you no longer use.',
    },
    {
      symptom: 'A Zap does not run',
      meaning: 'The Zap is off, the matching event has not happened, or its trigger shows **off** in ScopeGov after repeated failures.',
      fix: 'Check the Zapier box. A trigger that shows **off** has a red note saying why. Fix it, then click **Turn on**.',
    },
    {
      symptom: 'You revoked the key, but Zaps still receive events',
      meaning: 'Revoking stops Zapier from adding or removing triggers. Triggers already created keep working until turned off.',
      fix: 'Click **Turn off** or **Remove** on each one in the **Zapier** box.',
    },
    {
      symptom: 'Triggers you expect are missing from Zapier',
      meaning: 'Triggers are limited to events the key\u2019s creator could see in ScopeGov.',
      fix: 'Create the key from an account with the permission, such as View Financials for invoices.',
    },
  ],
  whatHappensNext: [
    'ScopeGov delivers each matching event to Zapier within about a minute. Failed deliveries are retried for around a day.',
    'After ten failed deliveries in a row, the trigger is turned off and says why.',
    'If your plan lapses or the workspace becomes read-only, events are not delivered until it is active again.',
  ],
  related: ['api-keys-create-and-revoke', 'webhooks-send-events-to-your-system', 'slack-updates-in-channel', 'permissions-decoder'],
  updated: '2026-10-30',
}
