// lib/integrations/events.ts
//
// The outbound event layer. emitIntegrationEvent() is called from the one choke point that already announces
// every business event (lib/utils/notify.ts), so integrations see exactly the events people see in the bell and
// inbox — they can never drift into a second, different list.
//
// It NEVER throws and never delays the caller's own work by more than one RPC: an integration outage must not
// break signing a SOW.

// NOTE: deliberately no import of lib/supabase/server here. lib/utils/notify.ts (which calls this) is reachable from
// client bundles through lib/utils/project-messages.ts, and server.ts pulls in next/headers. The caller passes its
// own service-role client instead.

/**
 * The events an integration may subscribe to. Deliberately narrower than the notification list:
 *   • no per-person events (comments, @mentions, member joined/left) — they target an individual, not the workspace;
 *   • no billing/security events (trial_ending, MFA, role changes) — those are not for a third party's eyes.
 * Names are dotted for the outside world; the notification key maps to them below.
 */
export const INTEGRATION_EVENT_MAP: Record<string, string> = {
  sow_signed: 'sow.signed',
  sow_declined: 'sow.declined',
  sow_changes_requested: 'sow.changes_requested',
  sow_expired: 'sow.expired',
  sow_stalled: 'sow.stalled',
  co_accepted: 'change_order.accepted',
  co_declined: 'change_order.declined',
  co_countered: 'change_order.countered',
  co_expired: 'change_order.expired',
  co_stalled: 'change_order.stalled',
  guardian_flag: 'guardian.flag_raised',
  guardian_flag_stalled: 'guardian.flag_stalled',
  invoice_sent: 'invoice.sent',
  invoice_payment_received: 'invoice.paid',
  invoice_payment_claimed: 'invoice.payment_claimed',
  invoice_overdue: 'invoice.overdue',
  invoice_disputed: 'invoice.disputed',
  payment_milestone_overdue: 'milestone.overdue',
  retainer_ending: 'retainer.ending',
}

export const INTEGRATION_EVENT_TYPES: readonly string[] = Object.values(INTEGRATION_EVENT_MAP)

export interface IntegrationEventInput {
  workspaceId: string
  /** The notification event key (e.g. 'sow_signed'). Anything not in INTEGRATION_EVENT_MAP is ignored. */
  eventKey: string
  entityType?: string | null
  entityId?: string | null
  projectId?: string | null
  data?: Record<string, unknown>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null)

/** Resolves true when the event was stored, false when it was ignored, deduped, or failed. Never throws. */
export async function emitIntegrationEvent(input: IntegrationEventInput, service: any): Promise<boolean> {
  try {
    const type = INTEGRATION_EVENT_MAP[input.eventKey]
    if (!type || !uuidOrNull(input.workspaceId)) return false
    if (!service || typeof service.rpc !== 'function') return false
    const { data, error } = await service.rpc('emit_integration_event', {
      p_workspace_id: input.workspaceId,
      p_event_type:   type,
      p_entity_type:  input.entityType || null,
      p_entity_id:    uuidOrNull(input.entityId),
      p_project_id:   uuidOrNull(input.projectId),
      p_data:         input.data || {},
      p_dedupe_minutes: 10,
    })
    if (error) { console.error('[integrations] emit failed:', error.message || error); return false }
    return !!data
  } catch (err) {
    console.error('[integrations] emit threw:', err)
    return false
  }
}
