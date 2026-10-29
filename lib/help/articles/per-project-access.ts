// lib/help/articles/per-project-access.ts
// Checked 2026-10-29 against: lib/utils/project-access.ts (canReadProject), api/projects/[id]/members, ProjectDetail Team tab,
// starting roles (migration 133), deactivate_member_atomic / restore_member_projects (migrations 067, 070).

import type { HelpArticle } from '../types'

export const perProjectAccess: HelpArticle = {
  slug: 'per-project-access',
  title: 'Giving someone access to one project, or to all of them',
  summary: 'Choose between seeing every project and seeing only the ones someone was added to.',
  category: 'team-permissions',
  order: 4,
  audience: { permissions: ['ASSIGN_TEAM_MEMBERS'], plan: 'all' },
  shortAnswer:
    'A person with **View All Projects** sees every project. Anyone else sees only the projects they were added to on the project\u2019s **Team** tab. ' +
    'Being on a project decides what they can open. Their role decides what they can do, and whether they can see prices and client details.',
  beforeYouStart: [
    'The person has accepted their invitation. Pending and deactivated people cannot be added.',
    'The Assign Team Members permission, and access to the project yourself.',
  ],
  steps: [
    {
      title: 'Decide which kind of access they need',
      body: 'Choose the role first, because it sets the default.',
      details: [
        'Everything: a role with **View All Projects**, such as Account Manager or Project Coordinator.',
        'Only their own work: a role with **View Own Projects**, such as Designer, plus a place on each project.',
      ],
    },
    {
      title: 'Add them to a project',
      body: 'Open the project, go to **Team** and click **Add member**. Pick the person from the list. \u201cSelect a workspace member to assign to this project.\u201d',
      details: [
        'The person who creates a project is added automatically.',
        'The person sees the project in their list straight away.',
      ],
    },
    {
      title: 'Remove them from a project',
      body: 'On the same tab, use the remove icon next to the person and confirm \u201cRemove NAME from this project?\u201d. They lose the project immediately. Nothing on the project changes.',
    },
    {
      title: 'Check what they can actually do',
      body: 'Access to a project does not grant anything else. Prices need **View Financials**, client details need **View Client Data**, and creating or sending documents needs the matching permission.',
    },
    {
      title: 'If you need to see it as them',
      body: 'Ask the person what they see, or compare their role on the **Roles** tab. If a project is missing from their list, they are probably not on its **Team** tab.',
    },
  ],
  dos: [
    'Add people to projects when they start work, and remove them when they finish.',
    'Give contractors a **View Own Projects** role and add them project by project.',
    'Review the **Team** tab of sensitive projects now and then.',
    'Use **View All Projects** only for people who need the whole picture.',
  ],
  donts: [
    'Do not give **View All Projects** just to avoid adding someone to projects.',
    'Do not expect adding a person to unlock prices or client data.',
    'Do not forget that the Reports page needs **View All Projects**.',
    'Do not add yourself to a project you have no access to. It is refused.',
  ],
  problems: [
    {
      symptom: 'I cannot see a project my colleague can',
      meaning: 'You lack **View All Projects** and are not on that project.',
      fix: 'Ask someone with **Assign Team Members** to add you, or ask an admin for **View All Projects**.',
    },
    {
      symptom: '**Add member** is missing',
      meaning: 'You lack **Assign Team Members**, or cannot open the project.',
      fix: 'Ask a project member who has it.',
    },
    {
      symptom: 'The person is not in the list when I click **Add member**',
      meaning: 'They have not accepted their invitation yet, or were deactivated.',
      fix: 'Check the Team page. Resend the invite or click **Reactivate**.',
    },
    {
      symptom: 'Someone was deactivated and has gone from every project',
      meaning: 'Deactivating a member sets their project assignments aside.',
      fix: 'Reactivating them restores the assignments. See \u201cRemoving a team member\u201d.',
    },
  ],
  whatHappensNext: [
    'The change takes effect as soon as it is saved.',
    'The project\u2019s audit trail records who was added or removed.',
  ],
  related: ['assign-team-members', 'default-roles', 'permissions-decoder'],
  updated: '2026-10-29',
}
