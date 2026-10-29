// lib/help/articles/custom-roles-and-mfa.ts
// Checked 2026-10-29 against: TeamClient (Roles tab, New role, badges), api/team/roles (+ [id]), lib/auth/mfa-policy.ts,
// components/settings/MfaSection.tsx, api/team/[id]/reset-mfa, lib/auth/step-up.ts.

import type { HelpArticle } from '../types'

export const customRolesAndMfa: HelpArticle = {
  slug: 'custom-roles-and-mfa',
  title: 'Creating a custom role, and which permissions call for two-factor',
  summary: 'Build a role that fits your team, and know when two-factor authentication is recommended for it.',
  category: 'team-permissions',
  order: 3,
  audience: { permissions: ['MANAGE_ROLES'], plan: 'pro' },
  shortAnswer:
    'On the **Roles** tab of the [Team](/team) page, click **New role**, name it, tick the permissions and click **Create role**. Custom roles need the Pro or Agency plan, or an active trial. ' +
    'Roles that include sensitive permissions (prices, client data, billing, approvals) are flagged for two-factor authentication.',
  beforeYouStart: [
    'The Manage Roles permission, and the Pro or Agency plan (or an active trial).',
    'A list of what the new role should and should not do. You can only tick permissions you hold yourself.',
  ],
  steps: [
    {
      title: 'Create the role',
      body: 'Open **Team**, then the **Roles** tab, and click **New role**. Fill in **Role name** (under 60 characters) and an optional **Description** (under 300). Tick permissions and click **Create role**.',
      details: [
        'Names must be unique in the workspace.',
        'Permissions you do not hold yourself cannot be ticked. Ask an Owner.',
      ],
    },
    {
      title: 'Edit, set the default or delete',
      body: 'On the **Roles** tab, click the pencil icon on a role, change it and click **Save role**. Any role, including the starting ones, can be edited within your own permissions.',
      details: [
        'Every workspace needs one default role, given to people invited without one. To change it, click the star icon (\u201cMake this the default role\u201d) on another role.',
        'The trash icon deletes a role. A role cannot be deleted while it is the default, while active members hold it, or while pending invitations use it. Reassign those people first.',
        'You cannot remove a permission if that would leave nobody in the workspace who holds it, such as the last person who can manage roles or approve documents.',
      ],
    },
    {
      title: 'Check which permissions call for two-factor',
      body: 'These permissions mark a role as handling sensitive data: **View All Projects**, **View Portfolio**, **View Audit Log**, **Manage Billing**, **Manage Roles**, **Manage Workspace Settings**, **Delete Projects**, **Approve Documents**, **Grant Exceptions**, **Approve Flags**, **View Financials** and **View Client Data**.',
      details: [
        'People with any of them show **Two-factor on**, **Two-factor recommended \u2014 not set up**, or **Two-factor required \u2014 not set up** on the Team page.',
        'By default two-factor is recommended, not forced. Your workspace may be set to require it, in which case the badge says required and the person is asked to set it up.',
      ],
    },
    {
      title: 'Ask people to turn it on',
      body: 'Each person opens [Settings](/settings), the **Account** tab, and clicks **Set up two-factor authentication**, then saves their **Backup codes**.',
      details: [
        'Backup codes are shown once. They replace the authenticator if it is lost.',
        'Some account actions, such as changing your email or two-factor settings, ask for your password or a code again.',
      ],
    },
    {
      title: 'Help someone locked out',
      body: 'If a colleague loses both their authenticator and their backup codes, someone with **Manage Roles** clicks **Reset MFA** on their card on the Team page. They set it up again at next sign-in.',
    },
  ],
  dos: [
    'Base a custom role on the closest starting role, then add or remove.',
    'Give a role a description so the next admin knows what it is for.',
    'Turn on two-factor for everyone with finance or settings access.',
    'Keep backup codes somewhere safe, not in the same place as the password.',
  ],
  donts: [
    'Do not tick **View Financials** or **View Client Data** by default. Most roles do not need them.',
    'Do not tick **Manage Roles** for someone you would not trust with the workspace.',
    'Do not delete a role to remove someone. Use **Deactivate** on the person.',
    'Do not disable two-factor on an account that holds sensitive permissions.',
  ],
  problems: [
    {
      symptom: '\u201cCustom roles require the Pro or Agency plan, or an active trial\u201d',
      meaning: 'Your plan does not include custom roles.',
      fix: 'Use the starting roles with **Overrides**, or upgrade in [Settings](/settings?tab=billing).',
    },
    {
      symptom: '\u201cCannot grant permissions you don\u2019t hold yourself\u201d',
      meaning: 'You tried to give a permission you lack.',
      fix: 'Untick it, or ask an Owner to create the role.',
    },
    {
      symptom: '\u201cA role with that name already exists in this workspace\u201d',
      meaning: 'Names must be unique.',
      fix: 'Choose another name.',
    },
    {
      symptom: '\u201cN active members currently hold this role. Reassign them first.\u201d',
      meaning: 'You cannot delete a role that is in use.',
      fix: 'Change their role on the Team page, then delete.',
    },
    {
      symptom: '\u201cThis would leave the workspace with no one who can \u2026\u201d',
      meaning: 'The change would remove the last holder of a permission that nobody could then grant back.',
      fix: 'Give that permission to another member or role first.',
    },
    {
      symptom: '\u201cEvery workspace needs a default role\u201d',
      meaning: 'You tried to unset the default role.',
      fix: 'Make a different role the default instead.',
    },
  ],
  whatHappensNext: [
    'People holding an edited role get the new permissions when they next refresh.',
    'New roles appear in the invite and **Change role** lists.',
    'Role creation, edits and deletions are recorded in the audit log.',
  ],
  related: ['default-roles', 'permissions-decoder', 'invite-team-and-roles'],
  updated: '2026-10-29',
}
