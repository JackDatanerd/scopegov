// lib/help/articles/search-with-command-palette.ts
// Checked against the product code on 2026-10-29: components/layout/CommandPalette.tsx (Ctrl/Cmd+K is the only trigger, 2-character minimum, group headings,
// quick-nav list and its gating, keyboard keys, error messages), app/api/search/route.ts (what each result type matches, the per-type caps,
// View Client Data / View Financials gating, accent-insensitive folded matching, scoping for members without View All Projects).
// If a visible search button is added, rewrite step 1 and the first problem.

import type { HelpArticle } from '../types'

export const searchWithCommandPalette: HelpArticle = {
  slug: 'search-with-command-palette',
  title: 'How do I search for a project, client, document or invoice?',
  summary: 'Open the search box with a keyboard shortcut, find anything by name or number, and understand why a result is missing.',
  category: 'getting-started',
  order: 9,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Press **Ctrl+K** (or **\u2318K** on a Mac) anywhere in ScopeGov, type at least two characters, and pick a result with the arrow keys and **Enter**. ' +
    'It searches projects, clients, contacts, team members, change orders, SOWs, invoices and scope flags at once. What you see depends on your permissions.',
  steps: [
    {
      title: 'Open the search box',
      minutes: 1,
      body: 'Press **Ctrl+K** on Windows or Linux, or **\u2318K** on a Mac. Press it again, or **Esc**, to close. There is no on-screen search button, so the shortcut is the only way in.',
      watchFor: 'On a phone or tablet without a keyboard you cannot open search. Use the filters on the [Projects](/projects), [Clients](/clients) and [Invoices](/invoices) pages instead.',
    },
    {
      title: 'Type what you remember',
      body: 'Type at least two characters. Results appear as you type, grouped under headings: **Projects**, **Clients**, **Client contacts**, **Team**, **Change orders**, **Statements of work**, **Invoices** and **Scope flags**.',
      details: [
        'Every word you type must match, so \u201cacme redesign\u201d finds a project about both.',
        'Accents are ignored. \u201cCafe\u201d finds \u201cCaf\u00e9\u201d.',
        'Each group shows only the best few matches: 5 projects, 4 each of clients, change orders, SOWs, invoices and flags, and 3 each of contacts and team.',
      ],
    },
    {
      title: 'Know what each type matches',
      body: 'Search looks in the places you would think of:',
      details: [
        '**Projects**: name, project type, your internal reference, and the client name.',
        '**Change orders** and **Invoices**: the title, the document or invoice number, the project name and the client name.',
        '**Statements of work**: the document number, the project name and the client name.',
        '**Scope flags**: the flag text, the project and the client.',
        '**Team**: names only. Email addresses stay on the [Team](/team) page.',
      ],
    },
    {
      title: 'Open a result',
      body: 'Use the up and down arrows to move, then press **Enter** to open it. Or click it.',
    },
    {
      title: 'Use it as a shortcut menu',
      body: 'With nothing typed, the box lists places you can jump to: Dashboard, Projects, Clients, SOW Registry, Approvals, Team, Settings and Help. **Invoices**, **Reports** and **Portfolio** appear only if your role and plan include them.',
    },
  ],
  dos: [
    'Search by document number when you have it. It is the fastest way to find a SOW, change order or invoice.',
    'Type a client\u2019s name to find their projects and documents together.',
    'Use the exact internal reference you give projects, if you use one.',
    'Press **Esc** to close it without leaving the page.',
  ],
  donts: [
    'Do not expect results from projects you cannot see. They never appear.',
    'Do not type a single character. Search starts at two.',
    'Do not rely on it for numbers inside documents. It finds titles, numbers and names, not body text.',
    'Do not worry about capital letters or accents. They are ignored.',
  ],
  problems: [
    {
      symptom: 'Ctrl+K does nothing, or opens my browser\u2019s own search',
      meaning: 'The shortcut only reaches ScopeGov when the page itself has focus.',
      fix: 'Click anywhere on the ScopeGov page first, then press the shortcut.',
    },
    {
      symptom: 'I know the invoice exists but it is not in the results',
      meaning: 'Invoices only appear for people with **View Financials**, and only on projects you can see.',
      fix: 'Ask an admin for the permission, or ask to be added to the project.',
    },
    {
      symptom: 'Client contacts never appear',
      meaning: 'Contacts need the **View Client Data** permission.',
      fix: 'Ask an admin to add it. See \u201cCan\u2019t see a button, or got Missing permission?\u201d.',
    },
    {
      symptom: 'I only see some of my company\u2019s projects',
      meaning: 'Without **View All Projects**, project and document results are limited to projects you are on.',
      fix: 'Ask someone to add you to the project, or ask an admin for View All Projects.',
    },
    {
      symptom: '\u201cNo results\u2026 but some results couldn\u2019t be loaded\u201d',
      meaning: 'One part of the search failed, so the answer may be incomplete.',
      fix: 'Wait a moment and search again. If it persists, email support@scopegov.app.',
    },
  ],
  whatHappensNext: [
    'The result opens at once. Search never changes anything, so you can open as many as you like.',
    'If something you expect is missing, the cause is almost always a permission or project access, not the spelling.',
  ],
  related: ['permissions-decoder', 'read-your-dashboard', 'assign-team-members'],
  updated: '2026-10-29',
}
