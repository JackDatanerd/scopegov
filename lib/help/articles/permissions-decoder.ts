// lib/help/articles/permissions-decoder.ts
// Labels and claims checked against the product code on 2026-10-29: lib/supabase/types.ts (the 24 permissions), the routes each
// permission gates (grep of app/api), components/layout/Sidebar.tsx (nav gating), components/team/TeamClient.tsx (role editor,
// Overrides, roster badges), lib/auth/mfa-policy.ts, lib/billing/plans.ts (read-only workspaces), lib/billing/entitlements.ts,
// lib/utils/permission-ceiling.ts, supabase/migrations/133 (starting roles). The role editor prints each permission by
// title-casing its key (SEND_SOW -> "Send Sow"), so this article uses those exact strings.

import type { HelpArticle } from '../types'

export const permissionsDecoder: HelpArticle = {
  slug: 'permissions-decoder',
  title: 'Can\u2019t see a button, or got \u201cMissing permission\u201d? Find the permission behind it',
  summary: 'Match what is missing to the permission that controls it, see who can grant it, and get your access fixed.',
  category: 'team-permissions',
  order: 1,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Almost everything in ScopeGov is controlled by a permission, and a role is a set of permissions. When a button, page or number is missing, or an error says **Missing permission**, find the matching permission below and ask a workspace admin for it. ' +
    'Admins grant it from the [Team](/team) page. If everything at once has become view-only, check for a read-only workspace first.',
  steps: [
    {
      title: 'Rule out a read-only workspace',
      minutes: 1,
      body: 'If a banner says **This workspace is read-only**, the trial or subscription has ended. ScopeGov then removes every permission that creates or sends things. You can still view and export everything.',
      details: [
        'Kept while read-only: viewing projects, financials, client data and Guardian history, the audit log and portfolio, plus billing and workspace settings.',
        'Someone with billing access clicks **Choose a plan** in the banner. Everything comes back as it was.',
      ],
    },
    {
      title: 'Read the permission name',
      minutes: 1,
      body: 'An error such as \u201cMissing permission: SEND_SOW\u201d names the permission. The role editor shows the same permission with capitals and spaces, so SEND_SOW is **Send Sow** and GRANT_EXCEPTIONS is **Grant Exceptions**.',
      watchFor: 'With no error, a missing button or menu item is hidden on purpose. Use the next three steps to find its permission.',
    },
    {
      title: 'Match a missing action: projects and documents',
      body: 'Find what you could not do:',
      details: [
        'Start a project, or add or edit a client (including the contracting company): **Create Projects**.',
        'Generate or regenerate a SOW, edit it, or attach files: **Edit Sow**.',
        'Send, remind or withdraw a SOW: **Send Sow**.',
        'Start, edit or revise a change order, or **Draft CO** from a flag: **Create Change Orders**.',
        'Send, remind, withdraw or close a change order, or accept a client\u2019s counter: **Send Change Orders**.',
        'Create, send or void an invoice, record a payment or resolve a dispute: **Send Invoices**.',
        'Complete, archive or reopen a project: **Mark Project Complete**.',
        'Add or remove people on a project\u2019s **Team** tab: **Assign Team Members**.',
        'Delete a project or client, or merge clients: **Delete Projects**.',
      ],
    },
    {
      title: 'Match a missing action: Guardian and approvals',
      body: 'Guardian and approvals have their own permissions:',
      details: [
        'Paste a client message or retry a check: **Submit Guardian Checks**.',
        'See past checks and their results: **Access Guardian History**.',
        'Resolve, close or escalate a flag: **Approve Flags**.',
        'Grant an exception on a flag: **Grant Exceptions**.',
        'Approve or reject a document in an approval workflow: **Approve Documents**. Building the workflow itself is in [Settings \u2192 Approvals](/settings/approvals).',
      ],
    },
    {
      title: 'Match a missing page, number or setting',
      body: 'What you can see, and where:',
      details: [
        'You only see projects you were added to, not all of them: you lack **View All Projects** (you have **View Own Projects**). The **Reports** page needs **View All Projects**.',
        'Prices, contract values and the **Invoices** page are missing: **View Financials**. Without it, amounts are also left out of send messages.',
        'Client details such as contacts and billing addresses are missing: **View Client Data**.',
        'No **Portfolio** page: **View Portfolio**, and a plan that includes it (Pro or Agency).',
        'No audit log export: **View Audit Log**. Export is an Agency plan feature.',
        'Cannot invite, resend or revoke invitations: **Invite Members**. Cannot change roles or reset someone\u2019s two-factor: **Manage Roles**.',
        'No plan, card or cancel controls: **Manage Billing**. Most [Settings](/settings) tabs: **Manage Workspace Settings**.',
      ],
    },
    {
      title: 'See what you hold, and ask for the change',
      minutes: 3,
      body: 'Anyone with **Manage Roles** (usually an Owner) opens [Team](/team) and fixes it in one of two ways:',
      details: [
        '**Change role**: pick a different role for the person, then click **Save role**.',
        '**Overrides**: set a single permission to **Always grant** or **Always revoke** for one person, then click **Save overrides**. **Use role** returns it to what the role says.',
        'On the **Roles** tab, **New role** builds a custom role from the permission checkboxes. Custom roles need the Pro or Agency plan, or an active trial.',
        'An admin can only give permissions they hold themselves, so a request may need to go to an Owner.',
      ],
      watchFor: 'Give the least access that lets the person work. Sensitive permissions (View All Projects, View Financials, View Client Data, View Portfolio, View Audit Log, Approve Flags, Grant Exceptions, Approve Documents, Manage Billing, Manage Roles, Manage Workspace Settings and Delete Projects) are flagged on the Team page until the person turns on two-factor authentication.',
    },
  ],
  dos: [
    'Tell the admin the permission name from the error, not just \u201cit does not work\u201d.',
    'Use **Overrides** for a one-off need and a role change for a lasting one.',
    'Start new people on the starting role closest to their job, then adjust.',
    'Ask people with sensitive permissions to turn on two-factor authentication.',
  ],
  donts: [
    'Do not share a login to get around a missing permission.',
    'Do not give **Manage Roles** to someone you would not trust with the whole workspace.',
    'Do not remove the last person who holds **Approve Documents** if you use approval workflows.',
    'Do not assume a missing page is a bug. Check the plan and the permission first.',
  ],
  problems: [
    {
      symptom: 'I have the permission, but the button is still missing',
      meaning: 'The action may also depend on the state of the item: a SOW must be a **Draft** to send, and a project must not be complete or archived.',
      fix: 'Check the status next to the document or project. See \u201cWhy can\u2019t I send this SOW?\u201d for the send checks.',
    },
    {
      symptom: 'I cannot see a project my colleague can',
      meaning: 'Without **View All Projects** you only see projects you were added to.',
      fix: 'Ask a project member with **Assign Team Members** to add you on the project\u2019s **Team** tab, or ask an admin for **View All Projects**.',
    },
    {
      symptom: 'The roles editor does not show a **New role** button',
      meaning: 'Custom roles are a Pro and Agency feature, and you also need **Manage Roles**.',
      fix: 'Use one of the starting roles with **Overrides**, or upgrade the plan.',
    },
    {
      symptom: 'I granted a permission and nothing changed',
      meaning: 'The person may need to reload. A grant you cannot make yourself is refused.',
      fix: 'Ask them to refresh the page. If the save was refused, an Owner needs to make the change.',
    },
  ],
  whatHappensNext: [
    'The new access applies as soon as the change is saved and the person refreshes.',
    'Changes to roles and overrides are recorded in the workspace audit log.',
    'If you added people or changed what they do, review their access again when their job changes.',
  ],
  related: ['invite-team-and-roles', 'assign-team-members', 'why-cant-i-send-sow'],
  updated: '2026-10-29',
}
