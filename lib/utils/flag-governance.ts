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

export type GovEntityType = 'flag' | 'exception'

export interface ResolvedEntity {
  projectId: string
  severity: string | null // only present for 'flag'; 'exception' borrows nothing by default
}

export async function resolveEntity(
  service: any,
  workspaceId: string,
  entityType: GovEntityType,
  entityId: string
): Promise<ResolvedEntity | null> {
  if (entityType === 'flag') {
    const { data } = await service
      .from('guardian_flags')
      .select('id, project_id, severity')
      .eq('id', entityId)
      .eq('workspace_id', workspaceId)
      .single()
    if (!data) return null
    return { projectId: data.project_id, severity: data.severity }
  }

  const { data } = await service
    .from('exceptions_log')
    .select('id, project_id, guardian_flags(severity)')
    .eq('id', entityId)
    .eq('workspace_id', workspaceId)
    .single()
  if (!data) return null
  return { projectId: data.project_id, severity: data.guardian_flags?.severity || null }
}

// Read access mirrors the same visibility rule the Guardian tab itself
// uses: VIEW_ALL_PROJECTS sees everything in the workspace, otherwise the
// user must be an assigned member of that specific project
// (project_members, joined through workspace_members — see BUG-058 note
// in app/api/projects/route.ts for why this join can't be a naive
// project_members.user_id filter).
export async function canReadProject(service: any, session: SessionUser, projectId: string): Promise<boolean> {
  if (hasPermission(session, 'VIEW_ALL_PROJECTS')) return true
  const { data } = await service
    .from('project_members')
    .select('project_id, workspace_members!inner(user_id)')
    .eq('project_id', projectId)
    .eq('workspace_members.user_id', session.id)
    .limit(1)
  return !!(data && data.length)
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
