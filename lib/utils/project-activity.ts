// lib/utils/project-activity.ts
//
// The project Activity tab's data, shared by the server page (first 50 rows) and
// GET /api/projects/[id]/activity ("Load more"). The tab was capped at 50 rows with no way to see anything
// older short of the workspace Audit Log (which needs its own permission) — a busy project's history
// simply stopped.

import { shapeActivityRow, type ShapedActivity } from '@/lib/utils/activity-format'

export const ACTIVITY_PAGE_SIZE = 50

export async function loadProjectActivity(
  service: any, workspaceId: string, projectId: string, viewFinancials: boolean, offset = 0,
): Promise<{ rows: ShapedActivity[]; hasMore: boolean }> {
  const { data, error } = await service
    .from('audit_log')
    .select('id, event_type, entity_type, entity_name, actor_name, created_at, metadata')
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .not('event_type', 'like', 'project_message.%')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + ACTIVITY_PAGE_SIZE) // one extra row = "is there a next page"
  if (error) throw new Error(`project activity: ${error.message}`)
  const all = data || []
  return {
    rows: all.slice(0, ACTIVITY_PAGE_SIZE).map((a: any) => shapeActivityRow(a, { viewFinancials })),
    hasMore: all.length > ACTIVITY_PAGE_SIZE,
  }
}
