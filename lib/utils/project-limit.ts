// lib/utils/project-limit.ts
//
// The plan's "active projects" allowance, enforced from ONE place.
//
// It used to live inline in POST /api/projects only. Two other transitions also add to the counted set
// and never checked it: POST /api/projects/[id]/reopen (Complete -> Active; Complete projects don't
// count) let a Solo workspace go create 2, complete 1, create another, then reopen — 3 live projects
// on a 2-project plan. Anything that moves a project INTO LIMIT_COUNTED_STATUSES must call this.
//
// The count-then-write pattern is inherently racy (two concurrent requests both see "1 of 2"), so
// callers also re-check with `isOverLimit` AFTER their write and roll back if they lost the race.

import { PLAN_LIMITS } from '@/lib/utils/format'
import { LIMIT_COUNTED_STATUSES } from '@/lib/utils/project-status'

/** null = unlimited (trial / pro / agency). */
export function projectLimitFor(planTier: string): number | null {
  return PLAN_LIMITS[planTier]?.projects ?? null
}

export async function countLimitedProjects(service: any, workspaceId: string): Promise<number> {
  const { count, error } = await service
    .from('projects').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).is('deleted_at', null)
    .in('status', [...LIMIT_COUNTED_STATUSES])
  if (error) throw new Error(`plan limit check failed: ${error.message}`)
  return count || 0
}

/**
 * The user-facing explanation. Drafts count (the wizard creates one at step 1) and can only be
 * freed by deleting them — Draft/Intake projects can be neither completed nor archived — so the
 * advice names the actions that actually work.
 */
export function projectLimitMessage(planTier: string, action: 'create' | 'reopen'): string {
  const limit = projectLimitFor(planTier)
  const plan = PLAN_LIMITS[planTier]?.name ?? planTier
  const noun = `active project${limit === 1 ? '' : 's'}`
  const base = `Your ${plan} plan is limited to ${limit} ${noun} (drafts count; completed and archived projects don't).`
  return action === 'reopen'
    ? `${base} Reopening this project would put you over the limit — delete a draft, complete another project, or upgrade first.`
    : `${base} Delete a draft, complete another project, or upgrade to create more.`
}

/** Pre-write check: true when one more counted project would exceed the allowance. */
export async function wouldExceedLimit(service: any, workspaceId: string, planTier: string): Promise<boolean> {
  const limit = projectLimitFor(planTier)
  if (limit == null) return false
  return (await countLimitedProjects(service, workspaceId)) >= limit
}

/** Post-write race check: true when the write we just made pushed the workspace past its allowance. */
export async function isOverLimit(service: any, workspaceId: string, planTier: string): Promise<boolean> {
  const limit = projectLimitFor(planTier)
  if (limit == null) return false
  return (await countLimitedProjects(service, workspaceId)) > limit
}

/**
 * Post-INSERT race check for project CREATE (Projects & Dashboard pass 2, B4).
 *
 * `isOverLimit` rolls back EVERY writer when a race pushes the count past the allowance, so two concurrent creates
 * for the last free slot both failed although one should have won. Here the counted projects are ranked by
 * (created_at, id) and only a project that falls outside the first `limit` of them is the loser: exactly one of two
 * racers is rolled back, deterministically. (Reopen keeps `isOverLimit` — a reopened project is old, so ranking by
 * creation time does not identify the loser there.)
 */
export async function isProjectBeyondLimit(service: any, workspaceId: string, planTier: string, projectId: string): Promise<boolean> {
  const limit = projectLimitFor(planTier)
  if (limit == null) return false
  const { data, error } = await service
    .from('projects').select('id')
    .eq('workspace_id', workspaceId).is('deleted_at', null)
    .in('status', [...LIMIT_COUNTED_STATUSES])
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`plan limit check failed: ${error.message}`)
  return !(data || []).some((r: any) => r.id === projectId)
}
