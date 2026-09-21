// lib/auth/login-audit.ts
//
// Sign-ins are recorded by a database trigger on auth.sessions (migration 066),
// which sees EVERY sign-in — including ones made straight against GoTrue. The
// app-side hooks (login form, OAuth callback, MFA challenge) remain as a
// fallback for a database where the trigger could not be created, and use this
// to avoid writing a second row for the same sign-in.

import { logAudit } from '@/lib/utils/audit'

export const LOGIN_DEDUPE_SECONDS = 180

export async function loginRecentlyAudited(service: any, userId: string, seconds = LOGIN_DEDUPE_SECONDS): Promise<boolean> {
  try {
    const since = new Date(Date.now() - seconds * 1000).toISOString()
    const { data } = await service
      .from('audit_log').select('id')
      .eq('actor_id', userId).eq('event_type', 'security.login_succeeded')
      .gte('created_at', since).limit(1)
    return !!(data && data.length)
  } catch {
    return false
  }
}

export async function logLoginOnce(service: any, p: {
  workspaceId: string; userId: string; email: string; name: string;
  method: string; extra?: Record<string, unknown>
  /** Only rows newer than this many seconds count as "this sign-in was already recorded". */
  sinceSeconds?: number
}): Promise<boolean> {
  if (await loginRecentlyAudited(service, p.userId, p.sinceSeconds ?? LOGIN_DEDUPE_SECONDS)) return false
  return logAudit(service, {
    workspaceId: p.workspaceId, actorId: p.userId, actorEmail: p.email, actorName: p.name,
    eventType: 'security.login_succeeded', entityType: 'user', entityId: p.userId, entityName: p.email,
    metadata: { method: p.method, source: 'app', ...(p.extra || {}) },
  })
}
