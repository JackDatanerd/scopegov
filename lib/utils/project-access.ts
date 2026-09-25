// lib/utils/project-access.ts
//
// Shared "can this session see this project" check. Extracted out of
// lib/utils/flag-governance.ts (which originally defined it just for
// itself) so that project_messages — a general per-project feature, not
// a governance one — can depend on plain project access without pulling
// in flag/exception-specific naming. flag-governance.ts re-exports this
// for backward compatibility with its existing importers.

import type { SessionUser } from '@/lib/supabase/types'
import { hasPermission } from '@/lib/auth/session'

// Read access mirrors the same visibility rule the project detail page
// itself uses (app/(app)/projects/[id]/page.tsx): VIEW_ALL_PROJECTS sees
// everything in the workspace, otherwise the user must be an assigned
// member of that specific project (project_members, joined through
// workspace_members — see BUG-058 note in app/api/projects/route.ts for
// why this join can't be a naive project_members.user_id filter).
//
// FIX (audit round 2, item #6): this never checked that the project
// itself belongs to the caller's workspace — it only checked whether a
// project_members row links this user to this project_id, full stop. Most
// callers happened to be safe because they separately re-fetch the
// project scoped to session.workspaceId before calling this (see
// app/api/projects/[id]/messages/route.ts's loadProject()), but two
// callers (messages/read, messages/unread-count) called this directly
// with no such check — and combined with a missing workspace check on
// POST /api/projects/[id]/members (also fixed this round), a member of
// one workspace could get a project_members row created against a
// project in a completely different workspace and pass this check for
// it. Scope the query by workspace_id here too so the primitive itself is
// safe regardless of what the caller does around it.
export async function canReadProject(service: any, session: SessionUser, projectId: string): Promise<boolean> {
  // FIX (Projects & Dashboard independent pass): the comment above promised the workspace scoping
  // lived in the primitive, but the VIEW_ALL_PROJECTS branch returned true for ANY project id — the
  // scoping only existed on the project_members branch. messages/read and messages/unread-count call
  // this with no scoped project fetch of their own, so an owner/admin of workspace A could pass a
  // workspace-B project UUID and (a) read that project's unread-message count and (b) write a
  // read-marker row against it. VIEW_ALL now means "every project IN THIS WORKSPACE".
  if (hasPermission(session, 'VIEW_ALL_PROJECTS')) {
    if (typeof projectId !== 'string' || !projectId) return false
    const { data } = await service
      .from('projects').select('id').eq('id', projectId).eq('workspace_id', session.workspaceId).limit(1)
    return !!(data && data.length)
  }
  // FIX (deep audit, RLS+permissions re-pass round 3): this queried
  // project_members directly, joining in workspace_members but filtering
  // only on user_id — never on workspace_members.status. The single thing
  // keeping a deactivated member's row out of project_members was one
  // un-retried RPC call at deactivation time (see app/api/team/[id]/route.ts
  // and migration 070); if that step ever failed, this function had no
  // independent check of its own and would keep granting access forever.
  // project_members_active (migration 070) is the same data narrowed to
  // currently-active members, with the workspace/user columns flattened in
  // (no PostgREST embedding — a view doesn't reliably carry the underlying
  // tables' foreign keys for embedding to resolve through) — belt-and-braces
  // against exactly that failure mode, not just the procedural fix on the
  // write side.
  const { data } = await service
    .from('project_members_active')
    .select('project_id')
    .eq('project_id', projectId)
    .eq('project_workspace_id', session.workspaceId)
    .eq('member_user_id', session.id)
    .limit(1)
  return !!(data && data.length)
}
