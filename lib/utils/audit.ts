interface AuditParams {
  workspaceId: string
  actorId: string
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
