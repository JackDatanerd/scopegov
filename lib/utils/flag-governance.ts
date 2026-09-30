// lib/utils/flag-governance.ts
//
// Shared resolution + access logic for the Phase 2 governance-scoped
// collaboration addendum (flag_comments / flag_attachments). Both are
// scoped to exactly two entity types — an open/resolved guardian_flags
// row, or an exceptions_log row — never a general "comment on anything"
// system. Centralized here so the comments and attachments routes can't
// drift on what counts as valid access.

import type { SessionUser } from '@/lib/supabase/types'
import { hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'

// Re-exported for existing importers (comments/attachments routes) —
// the check itself now lives in project-access.ts since it's no longer
// specific to flag/exception governance (project_messages uses it too).
export { canReadProject }

export type GovEntityType = 'flag' | 'exception'

export interface ResolvedEntity {
  projectId: string
  severity: string | null // only present for 'flag'; 'exception' borrows nothing by default
}

// FIX (independent pass 2, section 13 - G4): both lookups used `.single()` and ignored `error`, so ANY failure (outage,
// timeout, statement error) came back as null - which every caller turns into a 404 "Not found" for a flag or exception
// that exists. Only "no such row" (and a malformed id, Postgres 22P02 - the path param is not UUID-checked) is a genuine
// not-found; anything else now throws so the route's catch answers 500 instead.
export async function resolveEntity(
  service: any,
  workspaceId: string,
  entityType: GovEntityType,
  entityId: string
): Promise<ResolvedEntity | null> {
  if (entityType === 'flag') {
    const { data, error } = await service
      .from('guardian_flags')
      .select('id, project_id, severity')
      .eq('id', entityId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error && error.code !== '22P02') throw new Error(`resolveEntity(flag): ${error.message}`)
    if (!data) return null
    return { projectId: data.project_id, severity: data.severity }
  }

  const { data, error } = await service
    .from('exceptions_log')
    .select('id, project_id, guardian_flags(severity)')
    .eq('id', entityId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error && error.code !== '22P02') throw new Error(`resolveEntity(exception): ${error.message}`)
  if (!data) return null
  return { projectId: data.project_id, severity: data.guardian_flags?.severity || null }
}

// Writing (a comment or an attachment) is a governance action, not casual
// chat — gated behind the same permissions that let someone act on the
// flag/exception in the first place, so "who can annotate why" tracks
// "who can approve/grant" rather than every workspace member.
export function canWriteGovernance(session: SessionUser): boolean {
  return hasPermission(session, 'APPROVE_FLAGS') || hasPermission(session, 'GRANT_EXCEPTIONS')
}

export function isValidEntityType(v: string): v is GovEntityType {
  return v === 'flag' || v === 'exception'
}
