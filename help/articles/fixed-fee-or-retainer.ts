// lib/help/articles/fixed-fee-or-retainer.ts
// Every UI label below was checked against the product code on 2026-10-29; re-check them if a screen is renamed.
// There is no hourly project type in the product, so this article deliberately does not cover one.

import type { HelpArticle } from '../types'

export const fixedFeeOrRetainer: HelpArticle = {
  slug: 'fixed-fee-or-retainer',
  title: 'Fixed fee or retainer: which project type should I pick?',
  summary: 'Choose how the project is billed before you draft the SOW, because the choice is locked once a SOW exists.',
  category: 'clients-projects',
  order: 2,
  audience: { permissions: ['CREATE_PROJECTS'], plan: 'all' },
  shortAnswer:
    'Pick by how you get paid. Choose **One fixed fee** when the client pays one total for defined work, and **Same fee every month** (the **Retainer** type) when the same amount is billed every month. ' +
    'For a retainer, the amount you enter is the monthly fee, not the total. ' +
    'Decide before you generate the SOW: once any SOW exists you can no longer change the project type.',
  beforeYouStart: [
    'The agreed price, and whether it is one total or a monthly fee.',
    'For a retainer: how many months it runs, or whether it is open-ended.',
  ],
  steps: [
    {
      title: 'Decide which model fits',
      minutes: 1,
      body: 'Ask one question: is the price for a defined piece of work, or for a continuing monthly service?',
      details: [
        '**Fixed fee**: a website, a brand identity, a campaign. One total, paid in one go or in instalments.',
        '**Retainer**: ongoing content, support or design. The same fee every month, for any kind of work.',
      ],
    },
    {
      title: 'Choose it on the Basics step',
      minutes: 1,
      body: 'In **New project**, pick a card under **Project type**, then check **How is it billed?** shows the model you meant.',
      details: [
        'For a fixed fee, pick the closest kind of work: **Web Design**, **Mobile App**, **Branding**, **E-Commerce**, **Marketing**, **Video** or **Other**. This chooses which of your saved standard terms and defaults apply.',
        'For a retainer, pick **Retainer** or switch **How is it billed?** to **Same fee every month**. The switch remembers your earlier kind of work.',
      ],
    },
    {
      title: 'Enter the money',
      minutes: 2,
      body: 'Fill in the amount and currency. The line under the amount spells out what will be billed; read it back.',
      details: [
        'Fixed fee: **Contract value** is the whole project.',
        'Retainer: **Monthly retainer amount** is billed every month. Optionally set **What kind of work is it?** so your saved standard terms for that work apply.',
        'Retainer: **Retainer duration** takes 1 to 60 months. Leave it blank for open-ended.',
        '**Sales tax** is optional: a rate, then **Included in the amount** or **Added on top**.',
      ],
      watchFor: 'For a retainer, do not enter the total of the whole engagement. The amount is billed every month.',
    },
    {
      title: 'Choose the payment structure (fixed fee only)',
      minutes: 1,
      body: 'On the **Brief** step, pick **Payment structure**.',
      details: [
        '**50% upfront, 50% on delivery**, **100% upfront**, **Milestone-based** or **100% on delivery**.',
        'A retainer shows **Billed monthly (retainer)**, and it cannot be changed.',
      ],
    },
    {
      title: 'Accept or refuse a retainer suggestion',
      body: 'If your brief describes monthly billing but the project is a fixed fee, an amber box appears. Click **Bill as a monthly retainer** to switch, or **Keep as a fixed project**.',
      watchFor: 'Switching takes the project to the Retainer type. Check that the amount is the monthly fee.',
    },
  ],
  dos: [
    'Choose the billing model before you click **Generate SOW**.',
    'Read the sentence under the amount, and check it says what you agreed with the client.',
    'For a fixed project, pick the kind of work that matches, so the right standard terms apply.',
    'For a retainer, set a duration if the contract has an end date.',
  ],
  donts: [
    'Do not enter a retainer’s total value as the monthly amount.',
    'Do not leave the duration blank if the contract has a fixed term: an open-ended retainer keeps generating months until you complete or archive it.',
    'Do not expect to change the type after the SOW is generated. The **Project type** shows “Type is fixed once a SOW exists”.',
    'Do not use a retainer for a one-off project just to split payments. Use **Milestone-based** instead.',
  ],
  problems: [
    {
      symptom: 'The type, client and currency are greyed out in **Edit project**',
      meaning: 'A SOW already exists for the project, even a draft.',
      fix: 'They cannot be changed. If the model is wrong, ask an admin whether to delete the project (only Draft or Intake projects without a signed SOW can be deleted) and start again.',
    },
    {
      symptom: 'Sending the SOW is blocked because its payment terms do not match monthly billing',
      meaning: 'A retainer SOW has to use monthly billing, and a fixed-fee SOW cannot.',
      fix: 'Open the **SOW** tab, click **Regenerate from brief**, and send the new draft.',
    },
    {
      symptom: 'A message says a SOW can’t be drafted without a price',
      meaning: 'The contract value or monthly amount is zero.',
      fix: 'Enter the amount on the **Brief** step, then continue.',
    },
    {
      symptom: 'The project value looks too high or too low',
      meaning: 'For a retainer, the value is the monthly fee times the duration. For an open-ended retainer it grows by one month each time a month is billed.',
      fix: 'Check the monthly amount and the duration in **Edit project** (while the SOW is still a draft).',
    },
  ],
  whatHappensNext: [
    'When the client signs, the project turns **Active** and payment milestones are created from the SOW.',
    'Fixed fee: the milestones follow your payment structure.',
    'Retainer: the first monthly milestone appears at signing (or in your start-date month if that is later), and a new one is created each month. They appear on the **Billing** tab, ready to invoice.',
    'A paused retainer gets no new monthly milestones. When a fixed-term retainer reaches its end, the team members who can view financials are notified and no further months are created, unless a retainer renewal change order extends the term.',
  ],
  related: ['first-project', 'edit-project-before-and-after-sow', 'complete-archive-reopen-project'],
  updated: '2026-10-29',
}
