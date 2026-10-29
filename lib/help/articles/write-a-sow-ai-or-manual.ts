// lib/help/articles/write-a-sow-ai-or-manual.ts
//
// Every UI label and rule below was traced to the code on 2026-10-29:
// app/(app)/projects/new/page.tsx (wizard), components/projects/ProjectDetail.tsx (GenerateSowModal, SowTab),
// app/api/sow/generate/route.ts, app/api/sow/parse-brief, lib/ai/sow-content.ts, lib/billing/entitlements.ts,
// lib/utils/rate-limit.ts, components/sow/SowEditor.tsx. Re-check them if any of those screens or messages change.

import type { HelpArticle } from '../types'

export const writeASowAiOrManual: HelpArticle = {
  slug: 'write-a-sow-ai-or-manual',
  title: 'Writing a SOW: let AI draft it, or fill it in yourself',
  summary: 'Choose between pasting a client brief for AI to read and typing the scope yourself, and know what each route produces.',
  category: 'sow',
  order: 2,
  audience: { permissions: ['EDIT_SOW'], plan: 'all' },
  shortAnswer:
    'Every SOW starts from the same short form: objective, deliverables, out of scope, timeline, revision rounds and payment structure. ' +
    'You can paste a client email and let AI fill the form in, or type it yourself. Either way, ScopeGov then drafts every section from the form, using AI or, when AI is unavailable or your monthly AI drafts are used up, a standard template. ' +
    'There is no blank-page option, so the form is your \u201cfrom scratch\u201d route. You edit the draft before anything reaches your client.',
  beforeYouStart: [
    'The project exists and its contract value is above zero. ScopeGov will not draft a SOW for a project worth nothing.',
    'Your workspace has a governing law. Open [Settings](/settings), go to **Workspace** and fill in **Governing law**. Drafting is refused without it.',
    'Your standard wording is saved in [Settings](/settings): tax rate, late fee, payment terms, client review window and your standard exclusions. Drafts pick these up when they are generated, not afterwards.',
    'Something to describe the work: a client email, call notes, or your own bullet points.',
  ],
  steps: [
    {
      title: 'Choose where to start',
      body: 'For a new project, the **New project** wizard drafts the SOW on its last step, **Review & Send**. For a project that has no SOW yet, open its **SOW** tab and click **Generate SOW**.',
      details: [
        'A project can have only one live SOW. You cannot draft while one is out for signature or already signed.',
        'You cannot draft for a project that is complete or archived. Click **Reopen** on the project first.',
      ],
    },
    {
      title: 'Describe the work: AI pre-fill or manual',
      body: 'Pick the route that suits what you have in front of you. Both end at the same form.',
      details: [
        'AI route: paste the client\u2019s email or call notes and click **Extract scope** in the wizard (**Extract with AI** on the **SOW** tab). AI fills in the form for you to check.',
        'Manual route: choose **Manual** in the wizard (**Fill in manually** on the **SOW** tab) and type the fields yourself.',
        'If the brief describes monthly billing on a project that is not a retainer, a box says **This brief describes monthly billing**. Click **Bill as a monthly retainer** to switch the project, or **Keep as a fixed project**.',
      ],
      watchFor: 'AI reads the brief, it does not check it. Verify every name, number and date it fills in before you go on.',
    },
    {
      title: 'Complete the form',
      body: 'Check each field. **Objective** and **Deliverables** are required to draft.',
      details: [
        '**Deliverables** and **Out of scope**: one per line. **Out of scope** is optional on this form, but the SOW cannot be sent with that section empty. List the exclusions now, or write \u201cNone\u201d in the section later.',
        '**Timeline** and **How revisions are counted** are optional. **Revision rounds** takes a number from 1 to 10 and starts at 2.',
        '**Contracting company** and the signer\u2019s title: only if the client signs for a company. Leave blank if they sign personally.',
        '**Sales tax**: a rate, then **Included in the amount** or **Added on top**. It carries through to change orders and invoices.',
      ],
    },
    {
      title: 'Choose the payment structure',
      body: 'This decides how the fee is billed and how the Payment Terms are written.',
      details: [
        'Fixed projects: **50% upfront, 50% on delivery**, **100% upfront**, **Milestones** or **100% on delivery**.',
        'Retainers are always **Billed monthly (retainer)**. The choice is fixed, and only retainers can use it.',
        '**Milestones** drafts a **Payment Schedule** table that splits the contract value across proposed rows. You adjust the rows afterwards.',
      ],
    },
    {
      title: 'Generate the SOW',
      body: 'Click **Generate SOW**. All sections are drafted in one go and you land on the draft, status **Draft**.',
      details: [
        'Some sections are fixed wording written by ScopeGov, not by AI: **Parties**, **Governing Law** and **Signatures**, and for English SOWs **Termination** and **Dispute Resolution**. For retainers, and for upfront, 50/50 and on-delivery billing, **Payment Terms** is also standard wording built from your numbers.',
        '**Limitation of Liability** appears only if you chose a clause in Settings. Otherwise it stays hidden.',
        'Every AI step counts toward your plan\u2019s monthly AI drafts. See Common problems for the numbers.',
      ],
      watchFor: 'A banner saying the draft \u201cwas created from the standard template\u201d means AI drafting was unavailable or your AI drafts are used up. The draft is complete and usable, but read every section yourself.',
    },
    {
      title: 'Edit every section',
      body: 'On the **SOW** tab, click **Edit**. Pick a section on the left, and change it. Edits save as you type, and you will see **Saved**.',
      details: [
        '**Improve** rewrites one prose section with AI. You can type an instruction first, such as \u201cmake it more concise\u201d. Click **Undo AI change** if you do not like the result.',
        'If an AI rewrite changes or drops an amount, it is rejected and the section is left as it was. Edit figures yourself.',
        'Sections marked **req** cannot be hidden. Hide any other section with the eye button.',
        'Deliverables, Timeline, Roles and the Payment Schedule are tables. Use **Add row** and the arrows to arrange them.',
      ],
    },
    {
      title: 'Redraft from the brief, if the scope changes',
      body: 'While the SOW is still a **Draft**, click **Regenerate from brief** on the **SOW** tab. Change the form and click **Regenerate SOW**.',
      watchFor: 'Regenerating rewrites the text and tables of every section and overwrites your manual edits. Your show and hide choices, the MSA reference and any client change note are kept.',
    },
  ],
  dos: [
    'Paste the client\u2019s own words into the brief, then correct what AI gets wrong.',
    'Fill in **Out of scope** at this stage. It is the list Guardian measures later requests against.',
    'Set your tax, late fee and standard terms in Settings before drafting, so they are in the first draft.',
    'Read the whole draft in **Preview PDF** before you send it.',
  ],
  donts: [
    'Do not treat an AI draft as reviewed. It is a first draft.',
    'Do not regenerate after hours of editing unless you mean to lose those edits.',
    'Do not change the contract value after drafting and forget the Payment Terms text, which still shows the old figure.',
    'Do not start work before the SOW shows **Signed**.',
  ],
  problems: [
    {
      symptom: '\u201cSet your workspace\u2019s governing law in Settings \u2192 Workspace before generating a SOW\u201d',
      meaning: 'Drafting needs a governing law because it is printed in the contract.',
      fix: 'Open [Settings](/settings), go to **Workspace**, fill in **Governing law** (for example \u201cState of Delaware, United States\u201d) and save. Then generate again.',
    },
    {
      symptom: '\u201cSet a contract value greater than zero for this project before generating a SOW\u201d',
      meaning: 'The project\u2019s contract value is empty or zero.',
      fix: 'Click **Edit** at the top of the project and set the contract value (the monthly amount, for a retainer).',
    },
    {
      symptom: '\u201cA SOW for this project is out for signature\u201d or \u201cThis project already has a signed SOW\u201d',
      meaning: 'A project can have only one live SOW.',
      fix: 'Click **Withdraw** on the SOW that is out. If it is signed, it cannot be replaced: use a change order for new scope.',
    },
    {
      symptom: 'The banner says the draft was created from the standard template',
      meaning: 'AI drafting failed, or your workspace has used its AI drafts for the month. A failed AI draft is not counted against you.',
      fix: 'Edit each section, or click **Regenerate from brief** later. If the allowance is used up, it resets at the start of the next calendar month (UTC), or upgrade in Settings \u2192 Billing.',
    },
    {
      symptom: '\u201cThis workspace has used the AI drafts included in the plan this month\u201d',
      meaning: 'Your plan\u2019s monthly AI drafts are gone. Each plan includes a number: Solo 60, Starter 200, Pro 600, Agency 1,500, Trial 600. Extract, Generate, Improve, change order drafts and invoice drafts all count.',
      fix: 'Write that part by hand, wait for the monthly reset, or upgrade your plan.',
    },
    {
      symptom: '\u201cThis SOW has a pending approval request \u2014 cancel it before regenerating\u201d',
      meaning: 'An approval workflow is holding this draft, and it cannot change under approvers.',
      fix: 'Cancel the request in [Approvals](/approvals), then regenerate.',
    },
    {
      symptom: 'The request timed out, or you are not sure the SOW was created',
      meaning: 'Drafting can take a while, and the connection may have dropped after the SOW was saved.',
      fix: 'Refresh the project\u2019s **SOW** tab and check before you try again.',
    },
  ],
  whatHappensNext: [
    'The draft sits on the **SOW** tab as **Draft**, marked \u201cNot yet sent\u201d. Nothing reaches your client until you send it.',
    'A project that was still in Draft moves to Intake once its first SOW exists.',
    'Next, review the draft and check the wording, then send it.',
  ],
  related: ['sow-wording-terms-exclusions-payment', 'review-sow-before-sending', 'why-cant-i-send-sow', 'first-project'],
  updated: '2026-10-29',
}
