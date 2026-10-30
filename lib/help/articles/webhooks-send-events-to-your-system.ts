// lib/help/articles/webhooks-send-events-to-your-system.ts
//
// Checked 2026-10-30 against: components/settings/IntegrationsSection.tsx (Webhooks block), app/api/workspace/integrations/webhooks/*,
// lib/integrations/{delivery,signing,url,events,event-catalog,plans,guard}.ts, lib/auth/step-up.ts.

import type { HelpArticle } from '../types'

export const webhooksSendEventsToYourSystem: HelpArticle = {
  slug: 'webhooks-send-events-to-your-system',
  title: 'How do I send ScopeGov events to my own system with a webhook?',
  summary: 'Set up a webhook, verify its signature, and understand retries, so your own tools hear about signed SOWs, payments and flags.',
  category: 'integrations-security',
  order: 4,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'starter' },
  shortAnswer:
    'In [Settings](/settings), open **Integrations**, click **Add webhook**, give it a name and an https address, and tick the events. ScopeGov then sends a signed JSON message to that address each time one happens. ' +
    'Copy the signing secret when it is shown, because it is shown once. Your receiver should check the signature and ignore repeats. This article is for someone who can build or configure that receiver.',
  beforeYouStart: [
    'The Starter, Pro or Agency plan, or an active trial.',
    'The Manage Workspace Settings permission, plus the permission behind each event you pick: Send SOWs, Send Change Orders, Approve Flags or View Financials.',
    'A public https address that accepts POST requests and answers quickly. You will need to confirm it is you, with your password or authenticator code, when you save.',
  ],
  steps: [
    {
      title: 'Add the webhook',
      body: 'In **Integrations**, under **Webhooks**, click **Add webhook**. Fill in **Name** and **Endpoint URL**, tick **Events**, and click **Create webhook**.',
      details: [
        'The address must start with https:// and use a name, not a bare IP address. Addresses on private or internal networks are refused, and you cannot put a password in the address.',
        'Events come in groups: SOW (signed, declined, changes requested, expired, stalled), change orders, Guardian scope flags, invoices, payment milestones and retainers.',
        'A workspace can have up to 10 webhooks.',
        'ScopeGov asks you to confirm it is you if you have not signed in recently.',
      ],
    },
    {
      title: 'Copy the signing secret',
      body: 'A box appears titled **Signing secret \u2014 copy it now**. Click **Copy**, store it in your receiver\u2019s configuration, then click **I have saved it**.',
      watchFor: 'It cannot be shown again. If you lose it, click **New secret** on the webhook. The old secret stops working immediately.',
    },
    {
      title: 'Verify every message',
      body: 'Each delivery is a POST with a JSON body and these headers: X-ScopeGov-Signature, X-ScopeGov-Timestamp, X-ScopeGov-Delivery, X-ScopeGov-Event and X-ScopeGov-Attempt.',
      details: [
        'Signature: compute an HMAC-SHA256 of the timestamp, a full stop, then the exact raw request body, using your signing secret as the key. It must match the value after \u201cv1=\u201d in X-ScopeGov-Signature.',
        'Reject a timestamp more than about five minutes old, so a captured message cannot be replayed.',
        'Use X-ScopeGov-Delivery as an ID. If you see the same one twice, you have already handled it.',
        'The body has an id, type, created_at, workspace_id, project_id, the project and client names, and a data object with the details.',
      ],
    },
    {
      title: 'Answer quickly and correctly',
      body: 'Reply with a 2xx status within 8 seconds. Do the heavy work afterwards.',
      details: [
        'Any other answer, or no answer, is retried. A 410 Gone means \u201cstop\u201d: ScopeGov turns the webhook off.',
        'A redirect (3xx) is not followed and counts as a failure. Give ScopeGov the final address.',
      ],
    },
    {
      title: 'Test it',
      body: 'Click **Send test** on the webhook. A test event is delivered within about a minute.',
      details: [
        'The row shows when it last delivered, and how many are waiting or failed, with the last problem.',
        'Use **Turn off** and **Turn on** to pause it, and **Delete** to remove it. Deleting drops queued deliveries.',
      ],
    },
  ],
  dos: [
    'Verify the signature and the timestamp on every request.',
    'Make your receiver safe to run twice for the same delivery.',
    'Subscribe only to the events you act on.',
    'Keep the signing secret in a secrets manager, never in code.',
  ],
  donts: [
    'Do not parse and re-serialise the body before checking the signature. Use the raw bytes.',
    'Do not point a webhook at an address that redirects.',
    'Do not do slow work before replying. Eight seconds is the limit.',
    'Do not share the signing secret in chat or email.',
  ],
  problems: [
    {
      symptom: '\u201cThe URL must start with https://\u201d',
      meaning: 'Plain http addresses are refused.',
      fix: 'Use an https address with a valid certificate.',
    },
    {
      symptom: '\u201cThat address is not reachable from the internet\u201d or \u201cUse a hostname, not an IP address\u201d',
      meaning: 'ScopeGov will not deliver to localhost, internal names or bare IPs.',
      fix: 'Use a public domain name. For local testing, use a tunnelling service that gives you one.',
    },
    {
      symptom: '\u201cYou need more permissions to subscribe to: \u2026\u201d',
      meaning: 'You ticked an event that needs a permission you do not hold. This stops a settings admin reading payment amounts they could not see in the app.',
      fix: 'Untick it, or ask someone who holds the permission to create the webhook.',
    },
    {
      symptom: '\u201cA workspace can have up to 10 webhooks. Remove one first.\u201d',
      meaning: 'You reached the limit.',
      fix: 'Delete a webhook you no longer use.',
    },
    {
      symptom: 'A webhook shows **off** with \u201cTurned off after 10 deliveries in a row failed\u201d',
      meaning: 'Eight attempts over about a day failed for each of ten deliveries. ScopeGov stopped sending.',
      fix: 'Fix your receiver, click **Turn on**, then **Send test**.',
    },
    {
      symptom: 'The webhook is off and says the receiver answered 410 Gone',
      meaning: 'Your receiver asked ScopeGov to stop.',
      fix: 'Make the receiver return 2xx again, then click **Turn on**.',
    },
    {
      symptom: 'Your receiver says the signature is wrong',
      meaning: 'The secret is old, or the body was changed before it was checked.',
      fix: 'Click **New secret**, update your receiver, and verify against the raw body.',
    },
    {
      symptom: '\u201cWebhooks and API keys need the Starter plan or above\u201d',
      meaning: 'Your plan does not include webhooks.',
      fix: 'Upgrade in [Settings](/settings), under **Billing**.',
    },
  ],
  whatHappensNext: [
    'Matching events are delivered within about a minute, one message per event.',
    'A failed delivery is retried on a widening schedule, from a minute up to about twelve hours, for up to eight attempts in all. It is then marked failed.',
    'After ten failed deliveries in a row ScopeGov turns the webhook off and says why.',
    'If your plan lapses or the workspace becomes read-only, nothing is delivered until it is active again.',
  ],
  related: ['zapier-connect-scopegov', 'api-keys-create-and-revoke', 'slack-updates-in-channel', 'permissions-decoder'],
  updated: '2026-10-30',
}
