// lib/utils/activity-format.ts
//
// ONE place that turns an audit_log row into a sentence for the two "activity" surfaces: the Dashboard's
// workspace feed and a project's own Activity tab. They used to format events independently, so:
//   * the Dashboard knew ~20 event types and printed "Alice · invoice sent" (no project) for the rest,
//     the project tab knew none and printed "Alice · project status changed on Foo" for everything;
//   * both read `metadata.to` for a status change, which the writer never stored (fixed at the writer,
//     and legacy rows carry the structured `metadata.status.{from,to}` — both shapes are read here);
//   * a system event (no actor) rendered as a blank <strong> on the project tab.
//
// Nothing here forwards raw metadata to the browser: the output is sentences plus one optional
// detail line, and money only appears when the viewer has VIEW_FINANCIALS.

export type ActivityTone = 'green' | 'red' | 'amber' | 'blue'

export interface ActivityRowInput {
  id: string
  event_type: string
  entity_type?: string | null
  entity_name?: string | null
  actor_name?: string | null
  metadata?: any
  created_at: string
  project_id?: string | null
}

export interface ShapedActivity {
  id: string
  created_at: string
  tone: ActivityTone
  actor: string
  text: string
  detail: string | null
}

/**
 * Events that describe machinery rather than something a person did or needs to know: every Guardian
 * classification, every "client opened the link" ping, every automated reminder. Kept OFF the workspace
 * feed (a 14-row window drowns in them) but still shown on a project's own Activity tab, where the
 * history is the point.
 */
export const DASHBOARD_NOISE_EVENT_PATTERNS: readonly string[] = [
  'check.%', '%.link_viewed', 'reminder.%', '%.reminder_sent', 'approval.send_%',
  'project_message.%', 'flag_attachment.%',
]

export function activityTone(type: string): ActivityTone {
  if (type.includes('signed') || type.includes('accepted') || type.includes('completed') || type.includes('approved') || type.includes('payment_recorded') || type.includes('resolved'))
    return 'green'
  if (type.includes('declined') || type.includes('stalled') || type.includes('failed') || type.includes('rejected') || type.includes('overdue') || type.includes('expired') || type.includes('disputed'))
    return 'red'
  if (type.includes('flag') || type.includes('guardian') || type.includes('escalat') || type.includes('countered'))
    return 'amber'
  return 'blue'
}

const FIELD_LABELS: Record<string, string> = {
  name: 'name', disc: 'description', startDate: 'start date', internalRef: 'reference', type: 'project type',
  retainerDurationMonths: 'retainer length', currency: 'currency', clientId: 'client', contractValue: 'contract value',
}

function humanize(eventType: string): string {
  const s = eventType.replace(/[._]/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function statusTarget(m: any): string | null {
  const to = m?.to ?? m?.status?.to
  return typeof to === 'string' && to ? to : null
}

interface Ctx { a: ActivityRowInput; m: any; actor: string; name: string; viewFinancials: boolean }

// Each entry returns the sentence AFTER the actor's name. `name` is the entity's own label (a CO or SOW
// title, an invoice number, the person added to a project, …) or '' when there isn't one.
const LABELS: Record<string, (c: Ctx) => string> = {
  'project.created':        () => 'created the project',
  'project.updated':        ({ m }) => {
    const fields = Object.keys(m || {}).map(k => FIELD_LABELS[k]).filter(Boolean)
    return fields.length ? `edited the project (${fields.join(', ')})` : 'edited the project details'
  },
  'project.status_changed': ({ m }) => {
    const to = statusTarget(m)
    const from = m?.from ?? m?.status?.from
    if (to === 'Stalled') return 'paused the project'
    if (from === 'Stalled' && to === 'Active') return 'resumed the project'
    return to ? `changed the project status to ${to}` : 'changed the project status'
  },
  'project.completed':      () => 'marked the project complete',
  'project.reopened':       () => 'reopened the project',
  'project.archived':       () => 'archived the project',
  'project.unarchived':     () => 'unarchived the project',
  'project.deleted':        () => 'deleted the draft project',
  'project.scope_adjustment_made': () => 'adjusted the scope of record',
  'project.retainer_renewed': ({ m, viewFinancials }) =>
    viewFinancials && m?.new_monthly_amount != null
      ? `renewed the retainer at ${m.currency || ''} ${m.new_monthly_amount}/mo`.replace('  ', ' ')
      : 'renewed the retainer',
  'retainer.ended':         () => 'retainer term ended',
  'project_member.added':   ({ name }) => name ? `added ${name} to the team` : 'added a team member',
  'project_member.removed': ({ name }) => name ? `removed ${name} from the team` : 'removed a team member',

  'sow.drafted':            () => 'drafted the SOW',
  'sow.sent':               () => 'sent the SOW to the client',
  'sow.signed':             () => 'signed the SOW',
  'sow.declined':           () => 'declined the SOW',
  'sow.changes_requested':  () => 'requested changes to the SOW',
  'sow.withdrawn':          () => 'withdrew the SOW',
  'sow.expired':            () => 'SOW expired unsigned',
  'sow.reopened':           () => 'reopened the SOW for editing',
  'sow.marked_stalled':     () => 'SOW marked stalled (no response)',
  'sow.link_viewed':        () => 'opened the SOW link',

  'co.created':             ({ name }) => name ? `drafted change order ${name}` : 'drafted a change order',
  'co.revised':             ({ name }) => name ? `revised change order ${name}` : 'revised a change order',
  'co.sent':                ({ name }) => name ? `sent change order ${name}` : 'sent a change order',
  'co.accepted':            ({ name }) => name ? `accepted change order ${name}` : 'accepted a change order',
  'co.declined':            ({ name }) => name ? `declined change order ${name}` : 'declined a change order',
  'co.countered':           ({ name }) => name ? `countered change order ${name}` : 'countered a change order',
  'co.counter_accepted':    ({ name }) => name ? `agreed the counter-offer on ${name}` : 'agreed a counter-offer',
  'co.withdrawn':           ({ name }) => name ? `withdrew change order ${name}` : 'withdrew a change order',
  'co.expired':             ({ name }) => name ? `change order ${name} expired` : 'a change order expired',
  'co.escalated':           ({ name }) => name ? `escalated change order ${name}` : 'escalated a change order',
  'co.marked_stalled':      ({ name }) => name ? `change order ${name} marked stalled` : 'a change order was marked stalled',
  'co.amendment_failed':    () => 'change order accepted but the contract amendment failed to record',
  'co.link_viewed':         () => 'opened the change-order link',

  'flag.raised':            () => 'Guardian raised a scope flag',
  'flag.borderline_created':() => 'Guardian raised a borderline scope flag',
  'flag.borderline_reviewed': () => 'reviewed a borderline flag',
  'flag.resolved':          () => 'resolved a scope flag',
  'flag.closed':            () => 'closed a scope flag',
  'flag.escalated':         () => 'escalated a scope flag',
  'flag.exception_granted': () => 'granted a scope exception',
  'flag.converted_to_co':   () => 'converted a scope flag into a change order',
  'flag.reverted_to_open':  () => 're-opened a scope flag',
  'flag_comment.added':     () => 'commented on a scope flag',
  'flag_attachment.added':  () => 'attached a file to a scope flag',
  'flag_attachment.removed':() => 'removed a flag attachment',

  'invoice.created':        ({ name }) => name ? `created invoice ${name}` : 'created an invoice',
  'invoice.sent':           ({ name }) => name ? `sent invoice ${name}` : 'sent an invoice',
  'invoice.payment_recorded': ({ name }) => name ? `recorded a payment on ${name}` : 'recorded a payment',
  'invoice.payment_updated': ({ name }) => name ? `edited a payment on ${name}` : 'edited a payment',
  'invoice.payment_removed': ({ name }) => name ? `removed a payment from ${name}` : 'removed a payment',
  'invoice.overdue':        ({ name }) => name ? `invoice ${name} is overdue` : 'an invoice is overdue',
  'invoice.disputed':       ({ name }) => name ? `client disputed invoice ${name}` : 'client disputed an invoice',
  'invoice.dispute_resolved': ({ name }) => name ? `resolved the dispute on ${name}` : 'resolved an invoice dispute',
  'invoice.voided':         ({ name }) => name ? `voided invoice ${name}` : 'voided an invoice',
  'invoice.deleted':        ({ name }) => name ? `deleted draft invoice ${name}` : 'deleted a draft invoice',
  'invoice.exported':       () => 'exported an invoice',
  'invoice.link_renewed':   ({ name }) => name ? `renewed the client link for ${name}` : 'renewed an invoice link',
  'payment.milestone_generated': () => 'payment milestones were generated',
  'payment.milestone_overdue':   () => 'a payment milestone is overdue',

  'approval.requested':     () => 'requested an approval',
  'approval.approved':      () => 'approved a request',
  'approval.rejected':      () => 'rejected a request',
  'approval.cancelled':     () => 'cancelled an approval request',
  'approval.escalated':     () => 'escalated an approval request',
  'approval.step_approved': () => 'approved an approval step',
  'approval.step_reassigned': () => 'reassigned an approval step',
  'approval.no_reachable_approver': () => 'approval could not reach any approver',

  'check.classified':       () => 'Guardian checked a client message',
  'check.duplicate_skipped':() => 'Guardian skipped a duplicate message',
  'check.classification_failed': () => 'Guardian could not classify a message',
  'check.retried':          () => 'Guardian retried a message check',
  'reminder.sent':          () => 'a reminder was sent',
  'reminder.failed':        () => 'a reminder failed to send',
}

// Events where the client (not a team member) is the actor. The portal doesn't always record a name.
const CLIENT_EVENTS = new Set([
  'sow.signed', 'sow.declined', 'sow.changes_requested', 'sow.link_viewed',
  'co.accepted', 'co.declined', 'co.countered', 'co.counter_accepted', 'co.link_viewed', 'invoice.disputed',
])

// Events that are complete sentences on their own (something the SYSTEM observed or did) — no "System"
// prefix, which read as noise: "System SOW expired unsigned".
const SENTENCE_EVENTS = new Set([
  'sow.expired', 'sow.marked_stalled', 'co.expired', 'co.marked_stalled', 'co.amendment_failed',
  'invoice.overdue', 'payment.milestone_generated', 'payment.milestone_overdue', 'retainer.ended',
  'flag.raised', 'flag.borderline_created', 'approval.no_reachable_approver',
  'check.classified', 'check.duplicate_skipped', 'check.classification_failed', 'check.retried',
  'reminder.sent', 'reminder.failed',
])

export function describeActivity(a: ActivityRowInput, opts: { viewFinancials: boolean }): { actor: string; text: string } {
  const fn = LABELS[a.event_type]
  const name = (a.entity_name || '').trim()
  const isSentence = SENTENCE_EVENTS.has(a.event_type)
  const actor = isSentence ? '' : (a.actor_name || (CLIENT_EVENTS.has(a.event_type) ? 'Client' : 'System'))
  let text = fn
    ? fn({ a, m: a.metadata || {}, actor, name, viewFinancials: opts.viewFinancials })
    : humanize(a.event_type).toLowerCase()
  if (!actor) text = text.charAt(0).toUpperCase() + text.slice(1)
  return { actor, text }
}

/** Sentence + optional detail line for one row. `projectName` is appended on the workspace feed. */
export function shapeActivityRow(
  a: ActivityRowInput,
  opts: { viewFinancials: boolean; projectName?: string | null },
): ShapedActivity {
  const { actor, text } = describeActivity(a, { viewFinancials: opts.viewFinancials })
  let detail: string | null = null
  const m = a.metadata
  if (a.event_type === 'project.scope_adjustment_made' && m) {
    const field = m.field === 'out_of_scope' ? 'excluded item' : 'deliverable'
    if (m.old_value != null || m.new_value != null)
      detail = `Changed ${field} “${m.old_value ?? ''}” → “${m.new_value ?? ''}”${m.reason ? ` — ${m.reason}` : ''}`
  }
  return {
    id: a.id,
    created_at: a.created_at,
    tone: activityTone(a.event_type),
    actor,
    text: opts.projectName ? `${text} — ${opts.projectName}` : text,
    detail,
  }
}
