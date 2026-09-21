// lib/audit/categories.ts
//
// Event-type categories for the audit log filter dropdown. Patterns are
// static (never user input), matched with LIKE against audit_log.event_type.

export interface AuditCategory { id: string; label: string; patterns: string[] }

export const AUDIT_CATEGORIES: AuditCategory[] = [
  { id: 'sow',        label: 'Statements of work',   patterns: ['sow.%'] },
  { id: 'co',         label: 'Change orders',        patterns: ['co.%'] },
  { id: 'guardian',   label: 'Scope flags & checks', patterns: ['flag.%', 'flag_comment.%', 'flag_attachment.%', 'check.%'] },
  { id: 'invoices',   label: 'Invoices & payments',  patterns: ['invoice.%', 'payment.%', 'reminder.%'] },
  { id: 'projects',   label: 'Projects',             patterns: ['project.%', 'project_member.%', 'project_message.%', 'retainer.%'] },
  { id: 'clients',    label: 'Clients',              patterns: ['client.%', 'client_contact.%'] },
  { id: 'approvals',  label: 'Approvals',            patterns: ['approval.%', 'approval_workflow.%'] },
  { id: 'team',       label: 'Team & roles',         patterns: ['member.%', 'role.%', 'workspace.role_created'] },
  { id: 'security',   label: 'Security & sign-in',   patterns: ['security.%', 'user.%'] },
  { id: 'billing',    label: 'Billing',              patterns: ['billing.%'] },
  { id: 'workspace',  label: 'Workspace settings',   patterns: ['workspace.%'] },
  { id: 'exports',    label: 'Exports',              patterns: ['audit_log.%', 'reports.%', 'portfolio.%'] },
]

export function categoryFilter(id: string | null | undefined): string | null {
  const cat = AUDIT_CATEGORIES.find(c => c.id === id)
  if (!cat) return null
  return cat.patterns.map(p => `event_type.like."${p}"`).join(',')
}
