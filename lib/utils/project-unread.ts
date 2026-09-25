// lib/utils/project-unread.ts
//
// Unread Discussion messages per project for the current user, for the Projects list badge. One RPC
// (migration 077) for the whole page instead of one count query per project. Best-effort: if the function
// is not deployed yet, or the call fails, the list simply shows no badges — it must never break the page.

export async function loadUnreadMessageCounts(service: any, userId: string, projectIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (projectIds.length === 0) return out
  try {
    for (let i = 0; i < projectIds.length; i += 500) {
      const { data, error } = await service.rpc('project_unread_message_counts', {
        p_user_id: userId, p_project_ids: projectIds.slice(i, i + 500),
      })
      if (error) { console.error('[project-unread] rpc failed (badges skipped):', error.message); return out }
      for (const r of data || []) out.set(r.project_id, Number(r.unread) || 0)
    }
  } catch (e) {
    console.error('[project-unread] lookup failed (badges skipped):', e)
  }
  return out
}
