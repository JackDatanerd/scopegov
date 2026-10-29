// lib/help/articles/assign-team-members.ts
// Every UI label below was checked against the product code on 2026-10-29 (ProjectDetail Team tab, api/projects/[id]/members,
// lib/utils/project-access.ts, project page redaction, migration 133 role seeds); re-check them if a screen is renamed.

import type { HelpArticle } from '../types'

export const assignTeamMembers: HelpArticle = {
  slug: 'assign-team-members',
  title: 'How do I add people to a project, and who can see what?',
  summary: 'Add colleagues to a project from its Team tab, and understand why some people see a project, its prices or its client details and others do not.',
  category: 'clients-projects',
  order: 5,
  audience: { permissions: ['ASSIGN_TEAM_MEMBERS'], plan: 'all' },
  shortAnswer:
    'Open the project, go to the **Team** tab and click **Add member**. ' +
    'Adding someone only decides which projects they can see: it never changes what they are allowed to do, which comes from their role. ' +
    'People whose role includes View all projects see every project anyway, and everyone else sees only the projects they are on.',
  beforeYouStart: [
    'The colleague has accepted their invitation. Pending and deactivated people cannot be added.',
    'You can open the project yourself.',
  ],
  steps: [
    {
      title: 'Open the Team tab',
      minutes: 1,
      body: 'Open the project from [Projects](/projects) and click its **Team** tab. It lists everyone on the project with their email and the date they were added.',
      watchFor: 'The person who created the project is added automatically.',
    },
    {
      title: 'Add a member',
      minutes: 1,
      body: 'Click **Add member**. The **Add team member** window lists active workspace members who are not on the project yet, each with their email and role. Choose the person you want.',
      details: [
        'A person is not in the list if they have not accepted their invitation, or were deactivated. Invite or reactivate them on the [Team](/team) page first.',
        'If everyone is already on the project, the window says “All workspace members are already on this project.”',
        'You can change a project’s team at any point, including on a Complete or Archived project.',
      ],
    },
    {
      title: 'Know what the person gets',
      body: 'They get a notification, “You were added to” the project, and an email if their notification settings allow it. You are not notified if you add yourself.',
      details: [
        'Without View all projects, the project now appears in their **Projects** list. Before, it did not exist for them.',
        'What they can do on it is still decided by their role. Being on a project does not let a Designer send a SOW, for example.',
      ],
    },
    {
      title: 'Check what each person will see',
      body: 'Everyone who can open a project sees the same tabs, but the content depends on their permissions.',
      details: [
        'Without View financials: contract values, payment milestones and change order totals are hidden.',
        'Without View client data: the client’s name shows, but their email, phone and notes are hidden.',
        'The starting roles differ: **Account Manager** and **Project Coordinator** can view all projects, **Designer** only sees projects they are on. Your workspace may have changed these on the **Roles** tab.',
      ],
    },
    {
      title: 'Remove a member',
      body: 'Click the red ✕ next to their name on the **Team** tab and confirm “Remove … from this project?”. They are told they were removed.',
      watchFor: 'If their role includes View all projects, they can still open the project after you remove them.',
    },
  ],
  dos: [
    'Add people as soon as they start work on a project, so it shows up for them.',
    'Set what people can do through their role, and use the Team tab only for which projects they see.',
    'Remove people when they rotate off, so the project leaves their list.',
    'Give View financials and View client data only to the people who need them.',
  ],
  donts: [
    'Do not expect adding someone to give them permissions they do not have.',
    'Do not use the Team tab to hide a project from people who can view all projects. It cannot.',
    'Do not deactivate someone just to take them off one project.',
    'Do not forget to add designers and other restricted members: to them an unassigned project simply does not exist.',
  ],
  problems: [
    {
      symptom: 'There is no **Add member** button',
      meaning: 'You need the Assign Team Members permission. A workspace whose trial or subscription has lapsed is read-only.',
      fix: 'Ask an admin to add the permission, or to renew the plan.',
    },
    {
      symptom: 'My colleague is missing from the **Add team member** list',
      meaning: 'Only active members who are not already on the project are listed.',
      fix: 'On the [Team](/team) page, check they accepted their invitation, or click **Reactivate** if they were deactivated.',
    },
    {
      symptom: 'My colleague gets “Project not found”',
      meaning: 'Their role does not include View all projects, and they are not on this project.',
      fix: 'Add them on the **Team** tab.',
    },
    {
      symptom: 'My colleague can open the project but cannot see prices or the client’s email',
      meaning: 'Their role lacks View financials or View client data. Adding them to the project does not change that.',
      fix: 'Ask an admin to change their role, or to grant that single permission as an override.',
    },
    {
      symptom: 'The message says the member could not be found',
      meaning: 'The person was deactivated between opening the window and choosing them.',
      fix: 'Reactivate them on the [Team](/team) page and add them again.',
    },
    {
      symptom: 'I removed someone and they can still open the project',
      meaning: 'Their role includes View all projects, so project membership does not limit them.',
      fix: 'Change their role if they should not see projects they are not on.',
    },
  ],
  whatHappensNext: [
    'The person sees the project in their **Projects** list straight away, or loses it when you remove them.',
    'Project notifications only reach people who can open the project: everyone who can view all projects, plus the members of its team.',
    'Nothing is sent to the client.',
    'Adding and removing members are recorded in your audit log.',
  ],
  related: ['invite-team-and-roles', 'edit-project-before-and-after-sow', 'adding-a-client'],
  updated: '2026-10-29',
}
