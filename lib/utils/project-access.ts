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
