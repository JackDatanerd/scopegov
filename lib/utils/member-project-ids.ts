// lib/utils/member-project-ids.ts
//
// The ids of every project a project-restricted member (no VIEW_ALL_PROJECTS) is assigned to.
//
// FIX (Projects & Dashboard independent pass 6 — hardening): GET /api/projects, the Dashboard, the Projects list and the
// two Clients pages each ran this as a plain `select`, which PostgREST silently truncates at max_rows (1000) with no error.
// A restricted member's project_members rows are never removed when a project completes or is archived (the list only
// grows), so past 1000 assignments the oldest projects quietly vanished from every one of those screens — the very
// failure mode the project reads themselves were already paged to avoid. Paged here, with a query error thrown (never
// read as "no projects").
//
// Returns ids only; membership of a soft-deleted project is harmless because every caller then reads `projects`
// with `deleted_at is null`. Callers still chunk the list into `.in('id', …)` (see lib/utils/paginate.ts).

import { fetchAll } from '@/lib/utils/fetch-all'

export async function loadMemberProjectIds(service: any, userId: string): Promise<string[]> {
  const rows = await fetchAll<{ id: string; project_id: string }>('member project ids', (from, to) =>
    service
      .from('project_members')
      .select('id, project_id, workspace_members!inner(user_id)')
      .eq('workspace_members.user_id', userId)
      .order('id')
      .range(from, to))
  return Array.from(new Set(rows.map(r => r.project_id)))
}
