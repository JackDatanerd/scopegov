// lib/approvals/eligibility.ts
//
// Who can actually decide an approval step — used three ways:
//   * evaluateApprovalGate's pre-flight: refuse to create a request that
//     nobody can ever decide (the requester is the only approver, the
//     approver left the workspace, the role lost APPROVE_DOCUMENTS, …)
//     instead of parking the document behind a request that can never clear;
//   * the reassign endpoint's candidate list;
//   * hasDistinctAssignment(): can a chain that requires four-eyes across
//     steps be satisfied by DIFFERENT people at all?
//
// "Eligible" mirrors recordApprovalDecision exactly: an active workspace
// member who currently holds APPROVE_DOCUMENTS, is the named user / holds the
// assigned role, and can read the project the document lives on.

import { filterToProjectAccess } from '@/lib/utils/permissions-query'

export interface StepAssignment {
  approver_role_id: string | null
  approver_user_id: string | null
}

export interface ApproverPerson { id: string; name: string; email: string }

async function loadCandidates(
  service: any, workspaceId: string, projectId: string | null,
  where: { userId?: string | null; roleId?: string | null },
): Promise<ApproverPerson[]> {
  let q = service
    .from('workspace_members')
    .select('user_id, role_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
  if (where.userId) q = q.eq('user_id', where.userId)
  else if (where.roleId) q = q.eq('role_id', where.roleId)
  const { data } = await q.order('user_id').limit(500)

  const holders = (data || []).filter((m: any) => m.users?.id && m.effective_permissions?.APPROVE_DOCUMENTS === true)
  const permissionMap = new Map<string, Record<string, boolean>>(
    holders.map((m: any) => [m.user_id, m.effective_permissions || {}])
  )
  let people: ApproverPerson[] = holders.map((m: any) => ({ id: m.users.id, name: m.users.name, email: m.users.email }))
  if (projectId) people = await filterToProjectAccess(service, projectId, people, permissionMap)
  return people
}

/** Everyone who could decide this step right now. */
export async function eligibleApprovers(
  service: any, workspaceId: string, projectId: string | null, step: StepAssignment,
): Promise<ApproverPerson[]> {
  if (step.approver_user_id) return loadCandidates(service, workspaceId, projectId, { userId: step.approver_user_id })
  if (step.approver_role_id) return loadCandidates(service, workspaceId, projectId, { roleId: step.approver_role_id })
  return []
}

/** Every member who could be assigned an approval step on this project. */
export async function listApproverCandidates(
  service: any, workspaceId: string, projectId: string | null,
): Promise<ApproverPerson[]> {
  return loadCandidates(service, workspaceId, projectId, {})
}

/**
 * Is there a way to give every step a DIFFERENT approver? (bipartite matching —
 * steps on one side, people on the other, each person used at most once.)
 * Chains are short (a handful of steps), so the augmenting-path search is plenty.
 */
export function hasDistinctAssignment(stepCandidates: string[][]): boolean {
  const owner = new Map<string, number>() // person -> step index currently holding them

  function tryAssign(step: number, seen: Set<string>): boolean {
    for (const person of stepCandidates[step]) {
      if (seen.has(person)) continue
      seen.add(person)
      const holder = owner.get(person)
      if (holder === undefined || tryAssign(holder, seen)) {
        owner.set(person, step)
        return true
      }
    }
    return false
  }

  for (let s = 0; s < stepCandidates.length; s++) {
    if (!tryAssign(s, new Set())) return false
  }
  return true
}

export type FeasibilityResult = { ok: true } | { ok: false; error: string }

/**
 * Pre-flight for a request that is about to be created. Fails closed with a
 * message the requester can act on.
 */
export async function checkChainFeasibility(service: any, params: {
  workspaceId: string
  projectId: string | null
  steps: Array<StepAssignment & { step_order: number }>
  requesterId: string
  allowSelfApproval: boolean
  requireDistinctApprovers: boolean
}): Promise<FeasibilityResult> {
  const perStep: string[][] = []
  for (const step of params.steps) {
    const people = await eligibleApprovers(service, params.workspaceId, params.projectId, step)
    const ids = people
      .map(p => p.id)
      .filter(id => params.allowSelfApproval || id !== params.requesterId)
    if (ids.length === 0) {
      const onlyRequester = people.some(p => p.id === params.requesterId)
      return {
        ok: false,
        error: onlyRequester
          ? `Approval step ${step.step_order} can only be approved by you, and you can't approve your own request. Ask an admin to add another approver in Settings → Approvals, or to allow requesters to approve their own requests.`
          : `Approval step ${step.step_order} has no one who can approve it right now (the approver may have left the workspace, lost the approve permission, or can't access this project). Ask an admin to fix the workflow in Settings → Approvals.`,
      }
    }
    perStep.push(ids)
  }
  if (params.requireDistinctApprovers && !hasDistinctAssignment(perStep)) {
    return {
      ok: false,
      error: 'This workflow needs a different approver for every step, but there are not enough different people who can approve it. Ask an admin to add approvers in Settings → Approvals, or to relax the "different approver for each step" rule.',
    }
  }
  return { ok: true }
}
