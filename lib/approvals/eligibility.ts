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
  const { data, error } = await q.order('user_id').limit(500)
  // FIX (section-11 fresh pass, B5): a failed read came back as an empty candidate list — the gate then refused to
  // create the request with "nobody can approve this" (a transient error blamed on Settings), and the reassign picker
  // showed nobody. Callers all run inside a route try/catch: report a failure, not an empty answer.
  if (error) throw new Error(`could not load approver candidates: ${error.message}`)

  const holders = (data || []).filter((m: any) => m.users?.id && m.effective_permissions?.APPROVE_DOCUMENTS === true)
  const permissionMap = new Map<string, Record<string, boolean>>(
    holders.map((m: any) => [m.user_id, m.effective_permissions || {}])
  )
  let people: ApproverPerson[] = holders.map((m: any) => ({ id: m.users.id, name: m.users.name, email: m.users.email }))
  // strict: an unreadable member list must fail the lookup (the callers' route try/catch -> retryable 500), not read as
  // "nobody on this project can approve" and blame the workflow in Settings.
  if (projectId) people = await filterToProjectAccess(service, projectId, people, permissionMap, { strict: true })
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
 * Pre-flight for a request that is about to be created — or, with `excludeIds`,
 * for a reassignment against a request already in flight (see
 * reassignApprovalStep in engine.ts). Fails closed with a message the
 * requester/admin can act on.
 *
 * FIX (section-11 re-audit — flagship finding): `excludeIds` is new. Every
 * caller of this function used to run it ONLY at request creation, when
 * nobody has decided anything yet. reassignApprovalStep — added later,
 * specifically to rescue a stuck request — never re-ran ANY version of this
 * bipartite-matching feasibility check against the steps still to come; it
 * only confirmed the one step being reassigned had a live candidate right
 * now. Under require_distinct_approvers, that's not enough: reassigning step
 * N to someone who is also the only (or the last remaining) eligible
 * candidate for a LATER step quietly strands that later step the moment
 * someone approves step N — the distinct-approver rule then refuses the one
 * person assigned to it, with nobody else to turn to, and nothing detects
 * it (it's not a "no reachable approver" case — the person IS reachable,
 * just permanently disqualified). `excludeIds` lets a caller bar people who
 * have ALREADY used up their one-step quota (approved an earlier step) from
 * EVERY remaining step's candidate pool, not just the one being reassigned —
 * the same exclusion recordApprovalDecision itself enforces at decision
 * time, just applied up front instead of discovered too late.
 */
export async function checkChainFeasibility(service: any, params: {
  workspaceId: string
  projectId: string | null
  steps: Array<StepAssignment & { step_order: number }>
  requesterId: string
  allowSelfApproval: boolean
  requireDistinctApprovers: boolean
  excludeIds?: Iterable<string>
}): Promise<FeasibilityResult> {
  const excluded = new Set(params.excludeIds || [])
  const perStep: string[][] = []
  for (const step of params.steps) {
    const people = await eligibleApprovers(service, params.workspaceId, params.projectId, step)
    const ids = people
      .map(p => p.id)
      .filter(id => params.allowSelfApproval || id !== params.requesterId)
      .filter(id => !excluded.has(id))
    if (ids.length === 0) {
      const onlyRequester = people.some(p => p.id === params.requesterId) && !excluded.has(params.requesterId)
      return {
        ok: false,
        error: onlyRequester
          ? `Approval step ${step.step_order} can only be approved by you, and you can't approve your own request. Ask an admin to add another approver in Settings → Approvals, or to allow requesters to approve their own requests.`
          : `Approval step ${step.step_order} has no one who can approve it right now (the approver may have left the workspace, lost the approve permission, already approved an earlier step in this chain, or can't access this project). Ask an admin to fix the workflow in Settings → Approvals.`,
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
