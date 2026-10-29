// lib/help/categories.ts
// The ten help areas, in the order they appear on the Help home page. A category only shows once it has an article.

import type { HelpCategory } from './types'

export const HELP_CATEGORIES: HelpCategory[] = [
  { id: 'getting-started',       title: 'Getting started',          description: 'Set up your workspace and send your first SOW.' },
  { id: 'clients-projects',      title: 'Clients and projects',     description: 'Add clients, choose a project type, and manage a project through its life.' },
  { id: 'sow',                   title: 'Statements of work',       description: 'Draft, review, send and sign the agreement that defines the scope.' },
  { id: 'change-orders',         title: 'Change orders',            description: 'Price and agree new work before you do it.' },
  { id: 'invoicing',             title: 'Invoicing',                description: 'Bill milestones, retainers and change orders, and track payments.' },
  { id: 'guardian',              title: 'Guardian',                 description: 'Catch out-of-scope requests as they arrive.' },
  { id: 'approvals',             title: 'Approvals',                description: 'Route documents through the right people before they reach a client.' },
  { id: 'team-permissions',      title: 'Team, roles and permissions', description: 'Who can see and do what, and how to change it.' },
  { id: 'billing-plans',         title: 'Billing, plans and limits', description: 'Plans, limits, upgrades and what happens when a plan ends.' },
  { id: 'integrations-security', title: 'Integrations and security', description: 'Connect other tools, and keep your account safe.' },
]
