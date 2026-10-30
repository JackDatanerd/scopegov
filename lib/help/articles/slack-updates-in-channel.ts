// lib/help/articles/slack-updates-in-channel.ts
//
// Checked 2026-10-30 against: components/settings/IntegrationsSection.tsx (Slack block, SLACK_RESULT), app/api/workspace/integrations/slack/*,
// app/api/integrations/slack/callback, lib/integrations/{slack-config,slack-message,delivery,plans,guard,events}.ts, integrations/slack/manifest.json.

import type { HelpArticle } from '../types'

export const slackUpdatesInChannel: HelpArticle = {
  slug: 'slack-updates-in-channel',
  title: 'How do I get ScopeGov updates into a Slack channel?',
  summary: 'Connect Slack once, then choose which channel hears about signed SOWs, scope flags, payments and more.',
  category: 'integrations-security',
  order: 1,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'pro' },
  shortAnswer:
    'In [Settings](/settings), open the **Integrations** tab, click **Add to Slack**, and approve the ScopeGov app in Slack. Back in ScopeGov, click **Add channel**, pick a channel and tick the events you want. ' +
    'Each post names the project, client and amounts and has an **Open in ScopeGov** button. Slack posts are one-way notifications: you act on them in ScopeGov.',
  beforeYouStart: [
    'The Pro or Agency plan, or an active trial. On other plans the Slack box says it needs a higher plan.',
    'The Manage Workspace Settings permission in ScopeGov, and the right to add apps in your Slack workspace. If Slack refuses, ask a Slack admin.',
    'For events you want posted, you must hold the permission each one needs: Send SOWs for SOW events, Send Change Orders for change order events, Approve Flags for scope flags, View Financials for invoices, milestones and retainers.',
  ],
  steps: [
    {
      title: 'Connect your Slack workspace',
      body: 'In [Settings](/settings), open **Integrations**. In the **Slack** box, click **Add to Slack**. Slack opens and asks you to allow the ScopeGov app.',
      details: [
        'ScopeGov asks Slack for four permissions: post messages, post to public channels without being invited, and list public and private channels so you can pick one. It cannot read messages in your channels.',
        'Back in ScopeGov you see \u201cSlack is connected. Choose a channel below to start receiving events.\u201d',
      ],
      watchFor: 'If the box says Slack \u201cis not set up on this server yet\u201d, the connection is not available on this ScopeGov installation. Contact support.',
    },
    {
      title: 'Add a channel',
      body: 'Click **Add channel**. Under **Channel**, pick where posts should go. Under **Post these events**, tick the events you want, then click **Add channel** again.',
      details: [
        'Public channels work straight away.',
        'A private channel appears only after you invite the app. In Slack, open the channel and type /invite @ScopeGov.',
        'The event names are shown as ScopeGov\u2019s own labels, for example sow.signed, guardian.flag_raised and invoice.paid. You can only tick events your own permissions allow.',
        'A channel can have one rule, and a workspace can have up to 10 rules.',
      ],
    },
    {
      title: 'Send a test',
      body: 'On the channel\u2019s row, click **Send test**. A test message arrives within about a minute.',
      details: [
        'If it does not arrive, look under the channel\u2019s name. It shows how many posts are waiting or failed, and the last problem Slack reported.',
      ],
    },
    {
      title: 'Know what a post looks like',
      body: 'Each post has a headline such as \u201cSOW signed\u201d or \u201cScope flag raised\u201d, then the project, the client, the document number, and amounts or dates where they apply.',
      details: [
        'The **Open in ScopeGov** button opens the right tab of the project.',
        'Anything a client typed, such as a decline reason, is shown as plain text. It cannot ping the channel or mention anyone.',
        'You cannot approve, decline or dismiss anything from Slack. Posts are notifications only.',
      ],
    },
    {
      title: 'Change, pause or remove a rule',
      body: 'On the channel\u2019s row, use **Turn off** or **Turn on** to pause it, or **Delete** to stop posting to that channel.',
      details: [
        'There is no edit button. To change the events or move to another channel, delete the rule and add it again.',
        'To remove Slack entirely, click **Disconnect**. Its rules are deleted and the ScopeGov app\u2019s access is revoked.',
      ],
    },
  ],
  dos: [
    'Send each kind of event to the people who act on it: payments to finance, scope flags to the project leads.',
    'Use a private channel for anything with amounts, and invite the app to it first.',
    'Click **Send test** after every new rule.',
    'Reconnect promptly if the box says Slack needs reconnecting. Nothing posts while it is off.',
  ],
  donts: [
    'Do not expect to answer a scope flag from inside Slack.',
    'Do not post financial events to a channel that includes guests or clients.',
    'Do not delete the ScopeGov app from Slack without disconnecting it in ScopeGov first.',
    'Do not tick every event. Busy channels get muted.',
  ],
  problems: [
    {
      symptom: '\u201cSlack needs the Pro plan or above\u201d',
      meaning: 'Your plan does not include Slack. Trials include it until they end.',
      fix: 'Upgrade in [Settings](/settings), under **Billing**.',
    },
    {
      symptom: '\u201cThe ScopeGov app is not in #channel. In Slack, open the channel and type /invite @ScopeGov, then try again.\u201d',
      meaning: 'The channel is private and the app has not been invited.',
      fix: 'Invite the app in Slack, then click **Add channel** again.',
    },
    {
      symptom: '\u201cThat channel already has a rule. Edit it instead.\u201d',
      meaning: 'One rule per channel.',
      fix: 'Delete the existing rule and add it again with the events you want, or choose another channel.',
    },
    {
      symptom: '\u201cYou need more permissions to post: \u2026\u201d',
      meaning: 'You ticked an event that needs a permission you do not hold.',
      fix: 'Untick it, or ask someone who holds that permission to add the rule.',
    },
    {
      symptom: 'The Slack box says \u201cneeds reconnecting\u201d, with a red note',
      meaning: 'Slack rejected ScopeGov\u2019s access, usually because the app was removed or reauthorised in Slack. ScopeGov turned the rules off.',
      fix: 'Click **Reconnect**. If you reconnect to the same Slack workspace, the rules switch back on.',
    },
    {
      symptom: 'A rule shows **off** and says it was turned off after deliveries failed',
      meaning: 'Ten posts in a row could not be delivered, so ScopeGov stopped trying.',
      fix: 'Fix the cause (reconnect, or invite the app to the channel), click **Turn on**, and click **Send test**.',
    },
    {
      symptom: '\u201cThat channel is archived\u201d',
      meaning: 'Slack will not accept posts to an archived channel.',
      fix: 'Choose another channel.',
    },
  ],
  whatHappensNext: [
    'From now on, a matching event is posted within about a minute of happening. Failed posts are retried over roughly a day before they are given up on.',
    'Posts are not repeated. Each event is delivered once to each channel.',
    'If your plan lapses or the workspace becomes read-only, nothing is posted until it is active again.',
  ],
  related: ['webhooks-send-events-to-your-system', 'zapier-connect-scopegov', 'hubspot-sync-signed-sows', 'google-drive-archive-signed-documents'],
  updated: '2026-10-30',
}
