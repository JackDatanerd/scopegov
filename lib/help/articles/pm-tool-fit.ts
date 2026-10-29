// lib/help/articles/pm-tool-fit.ts
// Labels and claims checked against the product code on 2026-10-29 (ProjectDetail, projects/new, EditProjectModal,
// IntegrationsSection, lib/integrations/event-catalog.ts, lib/billing/entitlements.ts).

import type { HelpArticle } from '../types'

export const pmToolFit: HelpArticle = {
  slug: 'beside-your-pm-tool',
  title: 'How ScopeGov fits beside your project-management tool',
  summary: 'Know what to keep in ScopeGov and what to keep in Asana, ClickUp, Linear or whatever runs your delivery.',
  category: 'getting-started',
  order: 2,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Your project-management (PM) tool runs the work: tasks, sprints, who does what by when. ScopeGov holds the agreement about the work: the signed SOW, change orders, invoices and the scope Guardian watches. ' +
    'ScopeGov has no built-in connection to PM tools and does not create or update tasks there. You link the two by hand with an internal reference, and optionally by sending ScopeGov events out through webhooks or Zapier.',
  beforeYouStart: [
    'The name or ID your PM tool uses for the project, if you want to cross-reference it.',
    'For the optional connections: the Starter plan or above for webhooks, Zapier and API keys, and the permission to manage workspace settings.',
  ],
  steps: [
    {
      title: 'Decide what lives where',
      body: 'Keep tasks, schedules and day-to-day discussion in your PM tool. Keep the scope, the price and every change to either in ScopeGov.',
      details: [
        'ScopeGov: the SOW, **Change Orders**, the **Billing** tab, and **Guardian**.',
        'Your PM tool: tasks, assignees, deadlines, sprints.',
        'The rule of thumb: if the client has to agree to it or pay for it, it belongs in ScopeGov.',
      ],
    },
    {
      title: 'Cross-reference the project',
      body: 'When you create a project, type your PM tool\u2019s project name or ID into **Internal ref**. You can change it later: open the project, go to its edit screen and use **Internal reference**.',
      details: [
        'It is optional and never shown to your client.',
        'You can find a project by this value from the search box.',
      ],
      watchFor: 'It is a plain text field. ScopeGov does not check it and does not link to your PM tool from it.',
    },
    {
      title: 'Send client messages to Guardian',
      body: 'Open the project\u2019s **Guardian** tab and copy the address under **Forward client emails to**. Forward or CC client emails there, and Guardian checks them against the signed scope.',
      details: [
        'Guardian measures requests against the signed SOW, so it only starts once the SOW is signed.',
        'If you pause the project, forwarded emails are not checked. You can still paste text into the **Guardian** tab to check it by hand.',
      ],
    },
    {
      title: 'Add the people who need to see the project',
      body: 'On the project\u2019s **Team** tab, click **Add member** and pick a workspace member. A member whose role does not include View All Projects only sees the projects they are added to.',
    },
    {
      title: 'Optional: send ScopeGov events to your other tools',
      body: 'Go to [Settings](/settings?tab=integrations) and open the **Integrations** tab. Pick the connection that matches what you need.',
      details: [
        '**Zapier**: click **Create key** under **API keys**, then add ScopeGov in Zapier, paste the key when asked and pick a trigger such as **Invoice Paid** or **Scope Flag Raised**. A Zap can then create a task in your PM tool.',
        '**Webhooks**: click **Create webhook**, enter an **Endpoint URL** and choose the events. ScopeGov sends a signed JSON message to that URL when they happen.',
        '**Slack**: click **Add to Slack** to post scope flags, signed SOWs and payments into a channel (Pro plan or above).',
        'HubSpot and Google Drive connections are also on this tab (Pro plan or above).',
      ],
      watchFor: 'Events flow one way, out of ScopeGov. Nothing you change in your PM tool changes anything in ScopeGov.',
    },
    {
      title: 'When your PM tool shows extra work, raise a change order',
      body: 'If the team is doing something that is not in the SOW, do not just add a task and absorb it. Open the project\u2019s **Change Orders** tab and price it first.',
    },
  ],
  dos: [
    'Put your PM tool\u2019s project ID in **Internal ref** so you can find the project from either side.',
    'Forward client emails to the Guardian address, even the ones that look harmless.',
    'Use a Zap or webhook on **Change Order Accepted** to open the matching task in your PM tool.',
    'Treat the signed SOW, not a PM-tool task list, as the definition of what was sold.',
  ],
  donts: [
    'Do not expect tasks to be created in your PM tool automatically. There is no built-in connection.',
    'Do not store the scope only in your PM tool. Guardian can only measure against the signed SOW.',
    'Do not share an API key between tools. Create one per tool so you can revoke it on its own.',
    'Do not edit a signed SOW to match a changed task list. Use a change order.',
  ],
  problems: [
    {
      symptom: 'The **Integrations** tab says webhooks and API keys need a higher plan',
      meaning: 'Solo does not include webhooks, Zapier or API keys. Starter and above do; Slack, HubSpot and Google Drive need Pro or above.',
      fix: 'Upgrade in [Settings](/settings?tab=billing), or use the manual cross-reference only.',
    },
    {
      symptom: 'The **Integrations** tab shows no controls, or its buttons are greyed out',
      meaning: 'You may not have permission to manage workspace settings, or the workspace is read-only.',
      fix: 'Ask an admin with that permission, or subscribe if the workspace is read-only.',
    },
    {
      symptom: 'I forwarded a client email and no flag appeared',
      meaning: 'The project may be paused, the SOW may not be signed yet, or the email genuinely sits inside the signed scope.',
      fix: 'Check the **Guardian** tab: it says whether the project is being monitored. Resume it if paused.',
    },
    {
      symptom: 'A Zap I turned off in Zapier is gone from ScopeGov',
      meaning: 'Zaps that use a ScopeGov trigger are listed under **Zapier** only while they are on in Zapier.',
      fix: 'Turn the Zap back on in Zapier and it reappears.',
    },
  ],
  whatHappensNext: [
    'Nothing changes in your PM tool by itself. Your team keeps working there as before.',
    'Once the SOW is signed, Guardian checks forwarded client emails and raises a flag when a request looks out of scope.',
    'Events you connected start flowing as they happen. Use the test buttons on the **Integrations** tab to check a webhook or Slack channel.',
  ],
  related: ['first-project', 'workspace-setup'],
  updated: '2026-10-29',
}
