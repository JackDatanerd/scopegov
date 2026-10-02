// lib/utils/member-project-scope.ts
//
// Limits a query to the projects a project-restricted member (no VIEW_ALL_PROJECTS) is on — in the database, with
// an embedded filter, instead of reading every project_members row up front and sending the whole id list back in
// `.in('project_id', ids)`.
//
// Why: a restricted member's project_members rows are never removed when a project completes or is archived, so
// the list only grows. Every id costs ~37 bytes of request URL; past a couple of hundred the request exceeds
// gateway limits and fails (see ID_FILTER_CHUNK in lib/utils/paginate.ts, which fixed the same thing for the
// Dashboard / Projects list by chunking). Chunking cannot be applied to a paged, ordered, counted registry query
// (SOW / invoice registries, CSV export) or to Search's ~25 parallel queries without multiplying them, so these
// callers filter through the relationship instead: a URL of constant size, no row cap, one round trip fewer.
//
// Membership counts only while the workspace_members row is 'active' — the same rule as the
// project_members_active view (migration 070).
//
// Usage — the embed must be inner-joined in the select so non-matching rows are dropped, and the filters must be
// applied through the SAME path:
//
//   .from('invoices').select(`id, projects!inner(id, name${MEMBER_PROJECT_EMBED_SUFFIX})`)
//   scopeToMemberProjects(query, session.id, 'projects.project_members')
//
//   .from('projects').select(`id, name${MEMBER_PROJECT_EMBED_SUFFIX}`)
//   scopeToMemberProjects(query, session.id, 'project_members')

/** The embed itself (no leading comma). */
export const MEMBER_PROJECT_EMBED = 'project_members!inner(workspace_members!inner(user_id, status))'

/** The embed with a leading comma, for appending to an existing select list. */
export const MEMBER_PROJECT_EMBED_SUFFIX = `, ${MEMBER_PROJECT_EMBED}`

/**
 * Adds the membership filters to a PostgREST query builder.
 * @param memberPath path from the query's root table to its `project_members` embed:
 *   'project_members' for a query on `projects`, 'projects.project_members' for a query on a table with a
 *   `projects!inner(...)` embed (sow_documents, invoices, change_orders, guardian_flags …).
 */
export function scopeToMemberProjects<Q>(query: Q, userId: string, memberPath: string): Q {
  const q = query as any
  return q
    .eq(`${memberPath}.workspace_members.user_id`, userId)
    .eq(`${memberPath}.workspace_members.status`, 'active') as Q
}
