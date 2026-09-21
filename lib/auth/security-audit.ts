// lib/auth/security-audit.ts
//
// A security event about a PERSON (MFA on/off, backup codes, recovery, password,
// admin MFA reset) used to be written to one workspace's audit log — whichever
// happened to be active. Admins of the person's OTHER workspaces never saw that
// someone with access to their data had just lost a second factor. This writes
// the row to every workspace the person is an active member of.

import { logAudit } from '@/lib/utils/audit'

export interface SecurityAuditParams {
  actorId: string | null
  actorEmail: string
  actorName: string
  eventType: string
  entityId: string
  entityName: string
  metadata?: Record<string, unknown>
  /** Default true. false = only the caller-supplied fallback workspace. */
  allWorkspaces?: boolean
  fallbackWorkspaceId?: string | null
}

export async function activeWorkspaceIdsForUser(service: any, userId: string): Promise<string[]> {
  const { data } = await service
    .from('workspace_members')
    .select('workspace_id, workspaces(deleted_at)')
    .eq('user_id', userId).eq('status', 'active')
  return Array.from(new Set(
    ((data || []) as any[]).filter(m => m.workspaces && !m.workspaces.deleted_at).map(m => m.workspace_id as string)
  ))
}

export async function logSecurityAudit(service: any, p: SecurityAuditParams): Promise<void> {
  try {
    let ids: string[] = []
    if (p.allWorkspaces !== false) ids = await activeWorkspaceIdsForUser(service, p.entityId)
    if (ids.length === 0 && p.fallbackWorkspaceId) ids = [p.fallbackWorkspaceId]
    await Promise.all(ids.map(workspaceId => logAudit(service, {
      workspaceId, actorId: p.actorId, actorEmail: p.actorEmail, actorName: p.actorName,
      eventType: p.eventType, entityType: 'user', entityId: p.entityId, entityName: p.entityName,
      metadata: p.metadata || {},
    })))
  } catch (err) {
    console.error(`[audit] security event ${p.eventType} failed:`, err)
  }
}
