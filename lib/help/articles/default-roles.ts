// lib/help/articles/default-roles.ts
// Role contents come from the workspace seed (migration 133_trial_cap_counts_spent_trials_only.sql, create_workspace_atomic).
// Labels are the role editor's: permission keys, title-cased. Checked 2026-10-29.

import type { HelpArticle } from '../types'

export const defaultRoles: HelpArticle = {
  slug: 'default-roles',
  title: 'What can each starting role do?',
  summary: 'See exactly what Owner, Account Manager, Designer and Project Coordinator can and cannot do, and pick the closest one.',
  category: 'team-permissions',
  order: 2,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Every new workspace starts with four roles: **Owner**, **Account Manager** (the default for new invitees), **Designer** and **Project Coordinator**. ' +
    'A role is a bundle of permissions. These are the starting values, and an admin can edit them, so check the **Roles** tab on the [Team](/team) page for what your workspace actually has.',
  beforeYouStart: [
    'To change a role you need the Manage Roles permission, and you can only give out permissions you hold yourself.',
  ],
  steps: [
    {
      title: 'Owner',
      body: 'Everything. It goes to the person who created the workspace.',
      details: [
        'Only the owner can change the owner\u2019s access. Ownership can be handed over from Settings \u2192 Danger zone.',
        'It is the only starting role with **Manage Billing**, **Manage Roles**, **Invite Members**, **Delete Projects**, **View Audit Log**, **Manage Workspace Settings**, **Approve Documents** and **Grant Exceptions**.',
      ],
    },
    {
      title: 'Account Manager (the default role)',
      body: 'Runs client work from first project to invoice. It is given to anyone invited without a role.',
      details: [
        'Can: **View All Projects**, **View Financials**, **View Client Data**, **Create Projects**, **Edit Sow**, **Send Sow**, **Create Change Orders**, **Send Change Orders**, **Send Invoices**, **Approve Flags**, **Mark Project Complete**, **Assign Team Members**, **Submit Guardian Checks**, **Access Guardian History** and **View Portfolio**.',
        'Cannot: **Invite Members**, **Manage Roles**, **Manage Billing**, **Delete Projects**, **View Audit Log**, **Manage Workspace Settings**, **Approve Documents** or **Grant Exceptions**.',
      ],
      watchFor: 'It sees every project, every price and all client details. Think before using it as the default for new people.',
    },
    {
      title: 'Designer',
      body: 'Does the work and nothing else.',
      details: [
        'Can: **View Own Projects** (only projects they are added to), **Submit Guardian Checks** and **Access Guardian History**.',
        'Cannot see prices or client data, create or send anything, or change the team.',
      ],
    },
    {
      title: 'Project Coordinator',
      body: 'Keeps projects moving. Can see every project and send documents, but cannot write or price them.',
      details: [
        'Can: **View All Projects**, **Send Sow**, **Send Change Orders**, **Submit Guardian Checks** and **Access Guardian History**.',
        'Cannot: **Edit Sow**, **Create Change Orders**, **Send Invoices**, **View Financials** or **View Client Data**.',
      ],
    },
    {
      title: 'Choose, then adjust',
      body: 'Pick the closest role when you invite, then fine-tune one person with **Overrides**, or edit the role itself on the **Roles** tab.',
    },
  ],
  dos: [
    'Start people on the lowest role that lets them work.',
    'Use **Overrides** for one-off needs and edit a role for lasting ones.',
    'Check the **Roles** tab before assuming these defaults apply to you.',
    'Keep at least two people who can manage roles.',
  ],
  donts: [
    'Do not give Owner-level permissions for convenience.',
    'Do not change the default role without checking what it grants. New invitees receive it.',
    'Do not expect **View Own Projects** to show projects the person was not added to.',
    'Do not assume the Designer can see prices. They cannot.',
  ],
  problems: [
    {
      symptom: 'My role does not match this list',
      meaning: 'Roles can be edited, and older workspaces were set up with earlier values.',
      fix: 'Open [Team](/team) and the **Roles** tab for the current permissions.',
    },
    {
      symptom: 'I cannot edit the Owner role',
      meaning: 'Only the workspace owner can change it.',
      fix: 'Ask the owner, or have them hand ownership over from Settings \u2192 Danger zone first.',
    },
    {
      symptom: 'A button for something my role should allow is missing',
      meaning: 'The workspace may be read-only, or the item is in a state that blocks it.',
      fix: 'See \u201cCan\u2019t see a button, or got Missing permission?\u201d.',
    },
  ],
  whatHappensNext: [
    'Changing a role applies to everyone who holds it as soon as they refresh.',
    'Role changes are recorded in the audit log.',
  ],
  related: ['permissions-decoder', 'invite-team-and-roles', 'custom-roles-and-mfa'],
  updated: '2026-10-29',
}
