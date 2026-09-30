// lib/billing/limits.ts
//
// How a workspace's CURRENT usage sits against a target plan's seat and project allowance. Shared by
// api/billing/upgrade (refuses before money moves) and the Paystack webhook (records when usage grew past the
// allowance during the checkout window).
//
// FIX (Billing independent pass 10 — B5): both count queries in api/billing/upgrade used to read only `count`
// and default a failed read to 0 — so a failed read made the downgrade guard pass silently, the same class of
// bug round 6 fixed for the workspace/billing reads. A failed read is now reported as an error.

import { PLAN_LIMITS } from '@/lib/utils/format'
import { LIMIT_COUNTED_STATUSES } from '@/lib/utils/project-status'

export interface PlanFit {
  seats: { count: number; limit: number | null; over: boolean }
  projects: { count: number; limit: number | null; over: boolean }
}

export async function measurePlanFit(
  service: any, workspaceId: string, planKey: string,
): Promise<{ ok: true; fit: PlanFit } | { ok: false; error: string }> {
  const limits = PLAN_LIMITS[planKey]
  const seatLimit = limits?.seats ?? null
  const projectLimit = limits?.projects ?? null
  let seatCount = 0, projectCount = 0

  if (seatLimit != null) {
    const { count, error } = await service.from('workspace_members')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'active')
    if (error) return { ok: false, error: `seat count: ${error.message ?? error}` }
    seatCount = count || 0
  }
  if (projectLimit != null) {
    const { count, error } = await service.from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      // Same rule as POST /api/projects: only live projects count toward the allowance.
      .in('status', [...LIMIT_COUNTED_STATUSES])
    if (error) return { ok: false, error: `project count: ${error.message ?? error}` }
    projectCount = count || 0
  }
  return {
    ok: true,
    fit: {
      seats: { count: seatCount, limit: seatLimit, over: seatLimit != null && seatCount > seatLimit },
      projects: { count: projectCount, limit: projectLimit, over: projectLimit != null && projectCount > projectLimit },
    },
  }
}
