import { headers } from 'next/headers'
import { getClientIpFromHeaders } from './request-ip'

interface AuditParams {
  workspaceId: string
  // actor_id is `uuid REFERENCES users(id)` (001_initial_schema.sql) — every
  // automated call site passes null (never a placeholder string such as
  // 'system', which Postgres rejects as an invalid uuid).
  actorId: string | null
  actorEmail: string
  actorName: string
  eventType: string
  entityType: string
  entityId?: string
  entityName?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
  // Optional explicit project association. When omitted, a BEFORE INSERT
  // trigger (migration 056) derives it from entityType/entityId (and then
  // metadata.project_id), so most call sites never need to pass it. Pass it
  // when the entity row no longer exists at log time (e.g. after a hard
  // delete) or when entityType has no project relationship of its own.
  projectId?: string | null
}

// FIX (Reports & Audit re-pass #3 — cross-cutting): this function used to
// wrap the insert in try/catch and its comments (and several callers')
// claimed the catch "swallows and logs" failed inserts. It never did:
// supabase-js does NOT throw on a database error — it resolves to
// `{ data, error }` — so the catch only ever fired for network-level
// exceptions and every constraint/permission/payload failure vanished
// without a trace (not even a console line). We now read `error`, log it
// with enough context to find the call site, and return whether the row was
// written so callers that care (the billing webhook) can react.
//
// Still non-fatal by design: a failed audit write must not fail the user's
// action. But it must never be invisible.
// Actors that are the platform itself (crons, automated pipelines): the IP of
// whatever invoked the endpoint (a GitHub Actions runner, Vercel's cron
// service) says nothing about who did anything, so it is never auto-filled.
const SYSTEM_ACTOR_EMAILS = new Set(['cron@scopegov.app', 'system@scopegov.app', 'guardian@scopegov.app'])

// The IP of the request currently being served, when there is one. Route
// handlers run inside a request scope so next/headers works; anywhere else it
// throws, which just means "no ambient request".
function getAmbientClientIp(): string | undefined {
  try {
    return getClientIpFromHeaders(headers())
  } catch {
    return undefined
  }
}

export async function logAudit(service: any, params: AuditParams): Promise<boolean> {
  try {
    const ipAddress = params.ipAddress
      ?? (SYSTEM_ACTOR_EMAILS.has(params.actorEmail) ? undefined : getAmbientClientIp())
    const row: Record<string, unknown> = {
      workspace_id: params.workspaceId,
      actor_id:     params.actorId,
      actor_email:  params.actorEmail,
      actor_name:   params.actorName,
      event_type:   params.eventType,
      entity_type:  params.entityType,
      entity_id:    params.entityId || null,
      entity_name:  params.entityName || null,
      metadata:     params.metadata || {},
      ip_address:   ipAddress || null,
    }
    if (params.projectId) row.project_id = params.projectId
    const { error } = await (service as any).from('audit_log').insert(row)
    if (error) {
      console.error(
        `[audit] insert failed for ${params.eventType} (${params.entityType}/${params.entityId ?? '-'}):`,
        error.message ?? error,
      )
      return false
    }
    return true
  } catch (err) {
    console.error(`[audit] insert threw for ${params.eventType}:`, err)
    return false
  }
}

// For call sites (mostly crons) that build the raw snake_case audit_log row
// themselves instead of going through logAudit(). Same contract: never
// throws, never silent — a failed insert is logged with its event type.
export async function insertAuditRow(service: any, row: Record<string, unknown>): Promise<boolean> {
  try {
    const { error } = await (service as any).from('audit_log').insert(row)
    if (error) {
      console.error(`[audit] insert failed for ${String(row.event_type)}:`, error.message ?? error)
      return false
    }
    return true
  } catch (err) {
    console.error(`[audit] insert threw for ${String(row.event_type)}:`, err)
    return false
  }
}
