// lib/audit/categories.ts
//
// Event-type categories for the audit log filter dropdown. Patterns are
// static (never user input), matched with LIKE against audit_log.event_type
// (optionally narrowed to a specific entity_type — see 'reminder.%' below).

// FIX (deep audit, Reports & Audit log re-pass — independent redo):
// 'reminder.sent'/'reminder.failed' is ONE event_type shared across three
// document kinds (SOW, change order, invoice — see app/api/{sow,co,invoice}
// /[id]/remind/route.ts), disambiguated only by entity_type ('sow' |
// 'change_order' | 'invoice'). It was bucketed here as a plain event_type
// pattern under 'invoices' alone, which meant: filtering to "Statements of
// work" or "Change orders" never showed that document's own reminder
// events (a real gap in the audit trail for exactly what a compliance-
// minded reader would filter to), while filtering to "Invoices & payments"
// showed SOW/CO reminders mixed in as false positives. A plain string
// pattern still means "any event_type matching this LIKE"; an
// { eventType, entityType } pattern additionally requires that entity_type,
// so the same shared event_type can be split correctly across its three
// real categories.
export type CategoryPattern = string | { eventType: string; entityType: string }
export interface AuditCategory { id: string; label: string; patterns: CategoryPattern[] }

export const AUDIT_CATEGORIES: AuditCategory[] = [
  { id: 'sow',        label: 'Statements of work',   patterns: ['sow.%', { eventType: 'reminder.%', entityType: 'sow' }] },
  { id: 'co',         label: 'Change orders',        patterns: ['co.%', { eventType: 'reminder.%', entityType: 'change_order' }] },
  { id: 'guardian',   label: 'Scope flags & checks', patterns: ['flag.%', 'flag_comment.%', 'flag_attachment.%', 'check.%', 'exception.%'] },
  { id: 'invoices',   label: 'Invoices & payments',  patterns: ['invoice.%', 'payment.%', { eventType: 'reminder.%', entityType: 'invoice' }] },
  { id: 'projects',   label: 'Projects',             patterns: ['project.%', 'project_member.%', 'project_message.%', 'retainer.%'] },
  { id: 'clients',    label: 'Clients',              patterns: ['client.%', 'client_contact.%'] },
  { id: 'approvals',  label: 'Approvals',            patterns: ['approval.%', 'approval_workflow.%'] },
  // FIX (deep audit, Reports & Audit re-pass — cosmetic): 'workspace.role_created'
  // matched no real event type (role creation is logged as 'role.created',
  // already covered by 'role.%' below) — dead pattern, removed.
  { id: 'team',       label: 'Team & roles',         patterns: ['member.%', 'role.%'] },
  { id: 'security',   label: 'Security & sign-in',   patterns: ['security.%', 'user.%'] },
  { id: 'billing',    label: 'Billing',              patterns: ['billing.%'] },
  { id: 'workspace',  label: 'Workspace settings',   patterns: ['workspace.%'] },
  { id: 'exports',    label: 'Exports',              patterns: ['audit_log.%', 'reports.%', 'portfolio.%'] },
]

export function categoryFilter(id: string | null | undefined): string | null {
  const cat = AUDIT_CATEGORIES.find(c => c.id === id)
  if (!cat) return null
  return cat.patterns
    .map(p => typeof p === 'string'
      ? `event_type.like."${p}"`
      : `and(event_type.like."${p.eventType}",entity_type.eq."${p.entityType}")`)
    .join(',')
}
