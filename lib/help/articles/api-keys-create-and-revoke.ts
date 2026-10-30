// lib/help/articles/api-keys-create-and-revoke.ts
//
// Checked 2026-10-30 against: components/settings/IntegrationsSection.tsx (API keys block), app/api/workspace/integrations/api-keys/*,
// app/api/integrations/v1/* (the ONLY routes a key can call), lib/integrations/{api-keys,api-route,zapier,plans,guard}.ts, lib/auth/step-up.ts.

import type { HelpArticle } from '../types'

export const apiKeysCreateAndRevoke: HelpArticle = {
  slug: 'api-keys-create-and-revoke',
  title: 'What are API keys, and how do I create or revoke one?',
  summary: 'Create a key so a tool such as Zapier can connect to your workspace, and revoke it the moment it is no longer needed.',
  category: 'integrations-security',
  order: 6,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'starter' },
  shortAnswer:
    'An API key is a long secret that lets a tool connect to your workspace without a password. Create one in [Settings](/settings) under **Integrations**, copy it when it appears (it is shown once), and click **Revoke** if it leaks. ' +
    'Today a key can only connect Zapier. It cannot read or change your projects, SOWs, clients or invoices.',
  beforeYouStart: [
    'The Starter, Pro or Agency plan, or an active trial.',
    'The Manage Workspace Settings permission.',
    'To confirm it is you with your password or authenticator code when you create a key, if you have not signed in recently.',
  ],
  steps: [
    {
      title: 'Create a key',
      body: 'In **Integrations**, scroll to **API keys**. Type a name under **New key name**, such as \u201cZapier\u201d, and click **Create key**.',
      details: [
        'Names can be up to 80 characters. Use what the key is for, so you know which one to revoke later.',
        'A workspace can have up to 10 active keys.',
      ],
    },
    {
      title: 'Copy it now',
      body: 'A box titled **API key \u2014 copy it now** shows the key, which starts with sgk_. Click **Copy**, paste it into the tool, then click **I have saved it**.',
      watchFor: 'It is shown once and cannot be viewed again. If you lose it, create a new key and revoke the old one.',
    },
    {
      title: 'Know what you are looking at',
      body: 'Each key in the list shows its name, the first few characters, when it was created and when it was last used.',
      details: [
        'Use the first characters and the last-used time to tell keys apart and spot one nobody uses.',
        'Keys created in ScopeGov do not expire on their own.',
      ],
    },
    {
      title: 'Know what a key can do',
      body: 'A key can check that it works, fetch sample events, and add or remove Zapier triggers. That is all.',
      details: [
        'It cannot read or change projects, clients, documents or money. ScopeGov does not offer a general-purpose API yet.',
        'It can only add triggers that point at Zapier. It cannot aim events at any other address.',
        'It works with the permissions of the person who created it. If they lose a permission or leave the workspace, the key can no longer add triggers for events that permission covers.',
      ],
    },
    {
      title: 'Revoke a key',
      body: 'Click **Revoke** next to the key and confirm \u201cRevoke \u201cname\u201d? Anything using it stops working immediately.\u201d',
      details: [
        'It cannot be undone. Create a new key if the tool still needs access.',
        'Zap triggers that already exist are not removed. Turn them off or remove them in the **Zapier** box.',
        'Creating and revoking keys is recorded in the audit log.',
      ],
    },
  ],
  dos: [
    'Make one key per tool, so you can revoke one without breaking the others.',
    'Revoke any key you did not make or no longer use.',
    'Store the key in the tool\u2019s own connection screen or a password manager.',
    'Check **last used** now and then. A key never used is a key you do not need.',
  ],
  donts: [
    'Do not put a key in a document, a chat or a screenshot.',
    'Do not share one key between several people\u2019s tools.',
    'Do not create a key from an account that is leaving.',
    'Do not leave a leaked key active while you decide what to do. Revoke first.',
  ],
  problems: [
    {
      symptom: '\u201cA workspace can have up to 10 active API keys. Revoke one first.\u201d',
      meaning: 'You have reached the limit.',
      fix: 'Revoke a key you no longer use.',
    },
    {
      symptom: 'The **Create key** button is greyed out',
      meaning: 'The name is empty, the limit is reached, or your plan, role or this server does not allow it.',
      fix: 'Type a name and check the notices at the top of the **Integrations** tab.',
    },
    {
      symptom: '\u201cWebhooks and API keys need the Starter plan or above\u201d',
      meaning: 'Your plan does not include integrations. Keys also stop working if the workspace\u2019s plan lapses.',
      fix: 'Upgrade in [Settings](/settings), under **Billing**.',
    },
    {
      symptom: 'The tool says \u201cInvalid API key\u201d',
      meaning: 'It was copied wrongly, has been revoked, or the plan or workspace no longer allows it. ScopeGov gives the same answer for every cause on purpose.',
      fix: 'Create a new key and paste it again.',
    },
    {
      symptom: 'I lost the key',
      meaning: 'Keys are stored in a form that cannot be read back.',
      fix: 'Create a new key, update the tool, and revoke the old one.',
    },
  ],
  whatHappensNext: [
    'The key works straight away and stays valid until you revoke it, the workspace\u2019s plan no longer includes integrations, or the workspace is deleted.',
    'Revoking is immediate. The tool gets \u201cInvalid API key\u201d on its next request.',
    'The revoked key disappears from the list. Its creation and revocation stay in the audit log.',
  ],
  related: ['zapier-connect-scopegov', 'webhooks-send-events-to-your-system', 'permissions-decoder', 'custom-roles-and-mfa'],
  updated: '2026-10-30',
}
