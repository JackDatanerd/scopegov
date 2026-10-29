// lib/help/articles/workspace-setup.ts
// Labels and claims checked against the product code on 2026-10-29 (SettingsClient Workspace/Branding/Defaults tabs,
// DocumentNumberingSection, api/workspace/numbering and settings, app/onboarding).

import type { HelpArticle } from '../types'

export const workspaceSetup: HelpArticle = {
  slug: 'workspace-setup',
  title: 'Setting up your workspace: branding, numbering, defaults and currency',
  summary: 'Set the details that appear on every SOW, change order and invoice, so you only do it once.',
  category: 'getting-started',
  order: 3,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'all' },
  shortAnswer:
    'Everything here lives in [Settings](/settings). The **Workspace** tab holds your agency name, currency, governing law and billing details, **Branding** holds your logo, colour and signature, and **Defaults** holds your standard SOW terms. ' +
    'These pre-fill new documents and do not rewrite documents you have already sent.',
  beforeYouStart: [
    'Your agency\u2019s legal or trading name, and the law that should govern your contracts.',
    'A logo as a PNG or JPEG under 2 MB, and your brand colour.',
    'Your payment details, tax ID and usual payment terms, if you want them printed.',
  ],
  steps: [
    {
      title: 'Set your identity and currency',
      minutes: 5,
      body: 'Open [Settings](/settings) and the **Workspace** tab. Fill in the **Identity** block, then click **Save changes**.',
      details: [
        '**Workspace name** is internal. **Agency name** is the one printed on your documents.',
        '**Default currency** is the starting currency for new projects. You can still pick another on each project.',
        '**Timezone** controls the times shown in the audit log and in report PDFs.',
        '**Governing law** and **SOW language** go into every new SOW.',
      ],
      watchFor: 'Governing law is required: ScopeGov will not generate a SOW until it is filled in. Changing the currency later also resets your Guardian risk-alert threshold, and you are warned about approval rules in the old currency.',
    },
    {
      title: 'Add your billing identity',
      minutes: 5,
      body: 'Further down the **Workspace** tab, fill in the **Billing identity** block: address, **Tax ID**, phone, website, **Reply-to email** and **Default payment instructions**.',
      details: [
        'All of it is optional. Documents simply leave out what is empty.',
        '**Reply-to email** is where a client\u2019s reply to a SOW, change order or invoice email goes. Left blank, replies go to the person who sent it.',
      ],
    },
    {
      title: 'Choose your billing defaults',
      minutes: 4,
      body: 'Under **Billing defaults**, set **Default tax rate (%)**, **Amounts entered are** (tax-inclusive or before tax) and **Default payment terms (days)**, then click **Save changes**.',
      details: [
        'These pre-fill new invoices and change orders and can be edited on each one.',
        '**Late fee (% per month)** is only a stated term in the SOW. ScopeGov does not add it to invoices for you.',
        'The optional clause fields (liability, client materials, review window, portfolio use) add fixed wording to new SOWs. It is not legal advice, so have a lawyer read it.',
      ],
    },
    {
      title: 'Add your logo, colour and signature',
      minutes: 6,
      body: 'Open the **Branding** tab. Click **Upload logo**, pick a colour, then click **Save branding**.',
      details: [
        'The preview button shows how your colour looks to a client. A warning appears if white text on it is hard to read.',
        'Under **Agency signature**, draw your signature and click **Save signature**. It is the agency\u2019s signature, applied to every SOW and change order the workspace sends, whoever sends it.',
        'Under **Signatory**, enter a **Signatory name** and **Signatory position**, then click **Save signatory**. If blank, the agency name is printed instead.',
      ],
    },
    {
      title: 'Set your SOW defaults',
      minutes: 5,
      body: 'Open the **Defaults** tab. Set **Default revision rounds** and **Default payment structure**, and add your usual wording under **Standard terms**. Click **Save defaults**.',
      details: [
        'Use **Applies to** to give one project type its own values. The button becomes **Save** followed by the type and "override". Use **Remove override** to go back to the global default.',
        '**Standard exclusions** and **Standard assumptions** take one item per line.',
        'Standard terms are worked into every SOW that is generated, and added if the draft leaves them out.',
      ],
    },
    {
      title: 'Carry on your document numbers',
      minutes: 2,
      body: 'Back on the **Workspace** tab, scroll to **Document numbering**. Set the prefix and the next number for SOWs, change orders and invoices, then click **Save** on each row.',
      details: [
        'A document gets its number when it is sent, not while it is a draft.',
        'The preview next to each row shows the next number, for example SOW-0001.',
      ],
      watchFor: 'A number that was already issued under the same prefix cannot be used again. If you ask for one, ScopeGov tells you the lowest number you can use.',
    },
  ],
  dos: [
    'Set the governing law before your first SOW.',
    'Use **Preview PDF** on a draft SOW after changing branding, to see the result.',
    'Set per-project-type overrides only where a type really differs.',
    'Set your numbering before you send anything if you are moving from another tool.',
  ],
  donts: [
    'Do not expect branding or defaults changes to alter documents already sent or signed.',
    'Do not put anything you would not want a client to read in **Agency name** or **Default payment instructions**.',
    'Do not rely on the late-fee setting to charge fees. It only states the term.',
    'Do not change the currency casually once Guardian thresholds and approval rules depend on it.',
  ],
  problems: [
    {
      symptom: 'I cannot see **Workspace**, **Branding** or **Defaults** content',
      meaning: 'These tabs need the permission to manage workspace settings.',
      fix: 'Ask the workspace Owner or an admin to open them, or to grant you that permission.',
    },
    {
      symptom: 'My save is refused with a message that settings changed elsewhere',
      meaning: 'Someone else saved the same settings after you opened the page.',
      fix: 'Reload the page, check what changed, and make your edit again.',
    },
    {
      symptom: 'The logo will not upload',
      meaning: 'Only PNG and JPEG files under 2 MB are accepted.',
      fix: 'Export the logo in one of those formats and try again.',
    },
    {
      symptom: 'The numbering save says a number cannot be used',
      meaning: 'That number, or a higher one, has already been issued under the same prefix.',
      fix: 'Use the number the message gives, or choose a different prefix.',
    },
    {
      symptom: 'SOW generation says governing law is missing',
      meaning: 'The **Governing law** field is empty.',
      fix: 'Fill it in on the **Workspace** tab and click **Save changes**.',
    },
  ],
  whatHappensNext: [
    'New projects start with your currency, tax and payment defaults. New SOWs start with your standard terms.',
    'Sent and signed documents keep the values they were sent with.',
    'Changes are recorded in the audit log, so you can see who changed what.',
  ],
  related: ['first-project', 'invite-team-and-roles'],
  updated: '2026-10-29',
}
