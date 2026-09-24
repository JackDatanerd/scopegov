// lib/utils/notification-links.ts
//
// Shared by the bell dropdown and the /notifications inbox: where a notification
// leads, and how its age reads. Extracted from NotificationBell so both surfaces
// route identically (and so the routing can be unit tested).

export interface AppNotification {
  id: string
  type: string
  title: string
  body: string
  entity_type: string | null
  entity_id: string | null
  // Needed to deep-link flag/exception-comment notifications, which point at the
  // flag/exception itself (entity_type) rather than the project — migration 028.
  project_id: string | null
  read: boolean
  created_at: string
}

export function notificationHref(n: Pick<AppNotification, 'type' | 'entity_type' | 'entity_id' | 'project_id'>): string | null {
  const project = n.entity_type === 'project' && n.entity_id ? n.entity_id : null

  if (project) {
    // Billing-shaped events: invoice_* plus the two cron events that don't share the prefix.
    if (n.type.startsWith('invoice_') || n.type === 'payment_milestone_overdue' || n.type === 'retainer_ending')
      return `/projects/${project}?tab=billing`
    if (n.type.startsWith('guardian_') || n.type === 'escalation_flag')
      return `/projects/${project}?tab=guardian`
    if (n.type.startsWith('co_') || n.type === 'escalation_co')
      return `/projects/${project}?tab=co`
    if (n.type.startsWith('sow_'))
      return `/projects/${project}?tab=sow`
    return `/projects/${project}`
  }

  if (n.entity_type === 'project_message' && n.entity_id) return `/projects/${n.entity_id}?tab=discussion`
  if (n.entity_type === 'approval_request' && n.entity_id) return `/approvals?highlight=${n.entity_id}`

  // flag_comment_added points at the flag/exception itself; there's no per-flag deep link,
  // so it lands on the Guardian tab.
  if ((n.entity_type === 'flag' || n.entity_type === 'exception') && n.project_id)
    return `/projects/${n.project_id}?tab=guardian`

  // Trial countdown: the only action is choosing a plan.
  if (n.entity_type === 'workspace' && n.type === 'trial_ending') return '/settings?tab=billing'

  // Workspace-level team events (joined / role changed / ownership transferred).
  if (n.entity_type === 'team') return '/team'

  return null
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const diffMs = now - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  // Beyond a week "23d ago" stops being useful; show the date.
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined })
}
