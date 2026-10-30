// lib/help/articles/hubspot-sync-signed-sows.ts
//
// Checked 2026-10-30 against: components/settings/IntegrationsSection.tsx (HubSpot block, HUBSPOT_RESULT), app/api/integrations/hubspot/callback,
// app/api/workspace/integrations/hubspot/*, lib/integrations/{hubspot-config,hubspot-sync,hubspot-connection,external-refs}.ts, integrations/hubspot/README.md (cross-checked, not trusted).

import type { HelpArticle } from '../types'

export const hubspotSyncSignedSows: HelpArticle = {
  slug: 'hubspot-sync-signed-sows',
  title: 'How do I sync signed SOWs and payments to HubSpot?',
  summary: 'Connect HubSpot so each signed SOW creates a Closed-won deal, and later events land on its timeline.',
  category: 'integrations-security',
  order: 2,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS', 'VIEW_CLIENT_DATA'], plan: 'pro' },
  shortAnswer:
    'In [Settings](/settings), open **Integrations** and click **Connect HubSpot**. When a SOW is signed, ScopeGov creates the client\u2019s company and contact in HubSpot, or links to the ones you already have, plus a Closed-won deal. ' +
    'Accepted change orders, scope flags and payments are added to the deal\u2019s timeline as notes. It goes one way, from ScopeGov to HubSpot, and it never changes your existing contacts or companies.',
  beforeYouStart: [
    'The Pro or Agency plan, or an active trial.',
    'The Manage Workspace Settings and View Client Data permissions. Connecting shares client contact details with HubSpot.',
    'A HubSpot account with Deals, and the right to connect apps in it.',
  ],
  steps: [
    {
      title: 'Connect',
      body: 'In [Settings](/settings), open **Integrations**. In the **HubSpot** box, click **Connect HubSpot** and approve the permissions in HubSpot.',
      details: [
        'ScopeGov asks to read and write contacts, companies and deals. It does not add custom properties to your HubSpot.',
        'Approve every permission. If one is unticked, HubSpot is not connected.',
        'Back in ScopeGov you see \u201cHubSpot is connected. Signed SOWs will now create companies, contacts and Closed-won deals.\u201d',
      ],
    },
    {
      title: 'Choose which events sync',
      body: 'Under **Sync**, tick what you want. ScopeGov starts with every event you are allowed to sync.',
      details: [
        '**SOW signed (deal \u2192 Closed won)**',
        '**SOW declined (deal \u2192 Closed lost)**',
        '**Change order accepted (note)**, **Scope flag raised (note)** and **Payment received (note)**.',
        'You can only tick events your own permissions allow: Send SOWs, Send Change Orders, Approve Flags and View Financials.',
      ],
    },
    {
      title: 'Pick the deal pipeline',
      body: 'Under **Deal pipeline**, choose the pipeline for new deals. Won and lost deals use that pipeline\u2019s \u201cClosed won\u201d and \u201cClosed lost\u201d stages.',
      watchFor: 'A pipeline with no \u201cClosed won\u201d or no \u201cClosed lost\u201d stage is refused. If you later delete or rework the chosen pipeline, the sync turns itself off and says why.',
    },
    {
      title: 'Decide whether to send amounts',
      body: 'Tick **Send the contract value as the deal amount** if you want deals to carry the money. It is off by default.',
      details: [
        'Only someone who can view financials in ScopeGov can switch it on.',
        'The amount follows the contract value, including accepted change orders.',
      ],
    },
    {
      title: 'Bring over earlier projects',
      body: 'Click **Sync existing projects** to send projects that already have a signed SOW. It queues up to 200 per click, and you can click once every 10 minutes.',
      details: [
        'Earlier projects are added without filling your deal timelines with old notes.',
        'The message tells you how many were queued and how many were already there. Run it again for older ones.',
      ],
    },
    {
      title: 'Check it and find the deals',
      body: 'The box shows how many deals have synced and a link, **Open deals in HubSpot**. A line under the settings shows when it last synced and how many items are waiting or failed.',
    },
  ],
  dos: [
    'Make sure each client in ScopeGov has a company name and an email. Those are what ScopeGov matches on.',
    'Use a test or sandbox HubSpot account first if you are unsure what you want synced.',
    'Leave **Send the contract value as the deal amount** off unless your pipeline reporting needs it.',
    'Run **Sync existing projects** once, right after connecting.',
  ],
  donts: [
    'Do not expect edits in HubSpot to flow back. Sync is one way.',
    'Do not expect changes to a client in ScopeGov to update HubSpot contacts you already had.',
    'Do not pick a pipeline you are about to delete.',
    'Do not disconnect expecting HubSpot records to disappear. Nothing is ever deleted.',
  ],
  problems: [
    {
      symptom: '\u201cHubSpot was not connected because not every requested permission was granted\u201d',
      meaning: 'You unticked one of the permissions on HubSpot\u2019s approval screen.',
      fix: 'Click **Connect HubSpot** again and accept all of them.',
    },
    {
      symptom: '\u201cHubSpot accepted the sign-in but its deals could not be read\u201d',
      meaning: 'The HubSpot account has no Deals, or deal pipelines could not be read.',
      fix: 'Check that your HubSpot plan includes Deals, then connect again.',
    },
    {
      symptom: '\u201cYour account or plan cannot connect HubSpot (it also needs permission to view client data)\u201d',
      meaning: 'You lack View Client Data or Manage Workspace Settings, or the plan does not include HubSpot.',
      fix: 'Ask an owner for the permission, or upgrade in [Settings](/settings), under **Billing**.',
    },
    {
      symptom: 'The HubSpot box says \u201cneeds reconnecting\u201d',
      meaning: 'HubSpot revoked ScopeGov\u2019s access, usually because the app was uninstalled. The sync switched itself off.',
      fix: 'Click **Reconnect**. Reconnecting to the same HubSpot account switches the sync back on. A different account forgets the old account\u2019s records and asks for a pipeline again.',
    },
    {
      symptom: 'A signed SOW did not create a deal',
      meaning: 'The sync was off, the project had nothing to link (no client company or email), or an item is waiting or failed.',
      fix: 'Check the status line under the settings. Skipped items show the reason. Fix the client\u2019s details and use **Sync existing projects**.',
    },
    {
      symptom: 'The HubSpot sync turned itself off',
      meaning: 'Ten items in a row failed, or the pipeline was removed. The red note under the box says which.',
      fix: 'Fix the cause, then click **Turn on**.',
    },
  ],
  whatHappensNext: [
    'When a SOW is signed, an existing company with the same name (the oldest one) and an existing contact with the same email are linked. Otherwise new ones are created. A Closed-won deal is created in your chosen pipeline.',
    'A declined SOW makes the deal Closed lost. Accepted change orders, raised scope flags and received payments add notes to the deal.',
    'Retries and repeats never create duplicates. If you delete a record in HubSpot, the next event recreates it.',
    '**Disconnect** stops the sync and revokes access. Everything already in HubSpot stays.',
  ],
  related: ['slack-updates-in-channel', 'google-drive-archive-signed-documents', 'webhooks-send-events-to-your-system', 'adding-a-client'],
  updated: '2026-10-30',
}
