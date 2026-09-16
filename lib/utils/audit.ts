interface AuditParams {
  workspaceId: string
  // FIX (re-audit, Guardian/Billing section): actor_id is `uuid REFERENCES
  // users(id)` (001_initial_schema.sql) — several call sites were passing
  // the literal string 'system', which Postgres rejects as an invalid uuid.
  // logAudit's own catch swallows that error, so every one of those inserts
  // was silently vanishing — the audit trail for automated system actions
  // (guardian/inbound, billing/webhook) had a permanent, invisible hole.
  // actorId is now explicitly nullable; every automated call site below
  // passes null instead of a placeholder string.
  actorId: string | null
  actorEmail: string
  actorName: string
  eventType: string
  entityType: string
  entityId?: string
  entityName?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
}

export async function logAudit(service: any, params: AuditParams): Promise<void> {
  try {
    await (service as any).from('audit_log').insert({
      workspace_id: params.workspaceId,
      actor_id:     params.actorId,
      actor_email:  params.actorEmail,
      actor_name:   params.actorName,
      event_type:   params.eventType,
      entity_type:  params.entityType,
      entity_id:    params.entityId || null,
      entity_name:  params.entityName || null,
      metadata:     params.metadata || {},
      ip_address:   params.ipAddress || null,
    })
  } catch (err) {
    // Audit log failure is non-fatal — log to console but don't throw
    console.error('Audit log failed:', err)
  }
}
