// lib/help/articles/invite-team-and-roles.ts
// Labels and claims checked against the product code on 2026-10-29 (TeamClient, api/team/invite, seat-limit.ts,
// migration 133 role seeds, app/invite/[token], lib/billing/entitlements.ts).

import type { HelpArticle } from '../types'

export const inviteTeamAndRoles: HelpArticle = {
  slug: 'invite-team-and-roles',
  title: 'Inviting your team and picking roles',
  summary: 'Invite a colleague, give them the right access, and change it later without locking anyone out.',
  category: 'getting-started',
  order: 4,
  audience: { permissions: ['INVITE_MEMBERS'], plan: 'all' },
  shortAnswer:
    'On the [Team](/team) page, click **Invite member**, enter an email and choose a role. The person gets a link that works for 7 days. ' +
    'A role is a set of permissions, and you can only give out permissions you hold yourself. Your plan sets how many seats you have, and a pending invite uses one.',
  beforeYouStart: [
    'The colleague\u2019s email address.',
    'A free seat: Solo has 1, Starter 3, Pro 5, Agency 10. A trial has 10.',
    'An idea of what they need to do. Start with the least access that lets them work.',
  ],
  steps: [
    {
      title: 'Open the Team page',
      minutes: 1,
      body: 'Click **Team** in the sidebar. The top of the page shows how many seats are in use, for example \u201c2 of 3 seats in use\u201d.',
    },
    {
      title: 'Send the invitation',
      minutes: 2,
      body: 'Click **Invite member**. Enter the **Email address**, choose a **Role** (optional), then click **Send invitation**.',
      details: [
        'Left empty, **Role** uses the workspace default. New workspaces start with **Account Manager** as the default.',
        'The other starting roles are **Owner** (everything), **Designer** and **Project Coordinator**.',
        'Roles you cannot grant are greyed out.',
      ],
      watchFor: 'The invite counts as a seat while it is pending. If every seat is taken, the button is disabled until you revoke an invite, deactivate a member or upgrade.',
    },
    {
      title: 'What your colleague does',
      minutes: 2,
      body: 'They open the email and click the link. A new user clicks **Continue with Google** or sets a name and password, then clicks **Accept invitation**. Someone who already has an account signs in and accepts.',
      details: [
        'The invite only works for the email address you invited.',
        'Anyone with the link can use it, so use **Copy link** only to share it with the person invited.',
      ],
    },
    {
      title: 'Add them to projects',
      minutes: 2,
      body: 'Open a project, go to its **Team** tab and click **Add member**. A member whose role does not include View All Projects only sees projects they are added to.',
    },
    {
      title: 'Change a role later',
      minutes: 3,
      body: 'On the Team page, click **Change role** on their card, pick the new role and click **Save role**. It takes effect immediately.',
      details: [
        '**Overrides** grants or removes single permissions for one person on top of their role.',
        'Removing a role entirely leaves a person with no role-based permissions. It does not give them the default role.',
        'The **Roles** tab, for people with the Manage Roles permission, is where you create custom roles. Custom roles need the Pro or Agency plan, or an active trial.',
      ],
    },
    {
      title: 'Manage invitations and people who leave',
      minutes: 2,
      body: 'Pending invitations are listed under **Pending invitations** with **Resend**, **Copy link** and **Revoke**. To remove access, click **Deactivate** on a member\u2019s card.',
      details: [
        '**Resend** issues a new link. The old one stops working.',
        'A deactivated person loses access immediately. Their project assignments are kept and come back if you click **Reactivate**.',
        'Expired invitations are listed separately. **Resend** brings one back.',
      ],
    },
  ],
  dos: [
    'Give each person the least access that lets them do their job.',
    'Check the seat count before you invite.',
    'Deactivate people when they leave rather than leaving them active.',
    'Ask people with sensitive roles to set up two-factor authentication.',
  ],
  donts: [
    'Do not share an invite link in a public channel.',
    'Do not give someone a role just to unblock one task. Use **Overrides** for a single permission.',
    'Do not change the default role without checking what it grants, because new invitees receive it.',
    'Do not remove the last person who can manage roles.',
  ],
  problems: [
    {
      symptom: 'I cannot see **Invite member**',
      meaning: 'You do not have the Invite Members permission. The default role, Account Manager, does not include it.',
      fix: 'Ask the Owner or an admin to invite for you, or to change your role.',
    },
    {
      symptom: '**Invite member** is greyed out, or the invite says the workspace is at its seat limit',
      meaning: 'Every seat on your plan is used, counting pending invites.',
      fix: 'Click **Revoke** on a pending invite, **Deactivate** a member, or upgrade in [Settings](/settings?tab=billing).',
    },
    {
      symptom: 'The invite says \u201cCannot invite someone into a role with permissions you don\u2019t hold yourself\u201d',
      meaning: 'You can only grant permissions you have.',
      fix: 'Pick a smaller role, or ask someone with the right permissions to send it.',
    },
    {
      symptom: 'The invite says the person was deactivated in this workspace',
      meaning: 'They already belong to the workspace and were switched off.',
      fix: 'Click **Reactivate** next to them in the **Deactivated** list instead of sending a new invite.',
    },
    {
      symptom: 'The invite was created but the email could not be sent',
      meaning: 'The invitation exists, but delivery failed.',
      fix: 'Click **Copy link** and send it yourself, or click **Resend** later.',
    },
    {
      symptom: 'My colleague says the link has expired',
      meaning: 'Invites last 7 days.',
      fix: 'Click **Resend** on the expired invitation.',
    },
    {
      symptom: 'A member shows \u201cTwo-factor required \u2014 not set up\u201d',
      meaning: 'Their role includes sensitive permissions and they have not enrolled.',
      fix: 'Ask them to set it up. If they are locked out of their authenticator, click **Reset MFA** on their card.',
    },
  ],
  whatHappensNext: [
    'The person appears under **Members** as soon as they accept.',
    'Their role decides what they see in the sidebar and what buttons they get.',
    'Every invite, role change and deactivation is recorded in the audit log.',
  ],
  related: ['workspace-setup', 'trial-and-subscribing'],
  updated: '2026-10-29',
}
