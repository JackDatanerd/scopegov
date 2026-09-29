// lib/approvals/list.ts
//
// Read-side helpers for the approvals API, shared by GET /api/approvals (lists) and
// GET /api/approvals/[id] (one request). Route files cannot export anything but HTTP handlers, so these
// live here.

import { hasPermission } from '@/lib/auth/session'

export const REQUEST_FIELDS = `
  id, document_type, document_id, project_id, status, current_step, total_steps,
  context, created_at, decided_at, requested_by,
  send_failed_at, send_failed_reason, delivery_warning, sending_started_at,
  allow_self_approval, require_distinct_approvers, reminder_count, escalated_at,
  requester:users!approval_requests_requested_by_fkey(id, name, email),
  projects(id, name),
  approval_steps(
    id, step_order, status, note, decided_at, decided_by,
    approver_role_id, approver_user_id,
    roles(id, name),
    approver:users!approval_steps_approver_user_id_fkey(id, name),
    decider:users!approval_steps_decided_by_fkey(id, name)
  )
`

// FIX (section-11 audit, pass 1 — B2): the sidebar badge only needs a COUNT, but it used to download whole
// requests with four embeds on every navigation. Everything canDecideRequest() reads, and nothing else.
export const LIGHT_REQUEST_FIELDS = `
  id, project_id, status, current_step, requested_by, sending_started_at, send_failed_at,
  allow_self_approval, require_distinct_approvers,
  approval_steps(step_order, status, approver_role_id, approver_user_id, decided_by)
`

// Projects the viewer can see when they don't hold VIEW_ALL_PROJECTS. Mirrors
// canReadProject's join.
// FIX (independent pass 3): this queried the raw project_members table
// directly instead of project_members_active (migration 070), the
// status-defensive view canReadProject() and filterToProjectAccess() both
// already switched to specifically so a project-membership row can't grant
// a read once the member has been deactivated. In practice this route's own
// session check already requires an active session, so a deactivated user
// can't reach it — but that's exactly the "trusting the invariant blindly"
// migration 070 says not to rely on: a raw project_members row surviving
// deactivation (e.g. a future code path that misses the cleanup) would
// silently widen this one endpoint's project scope again without anything
// here catching it. Switched to the same view for the same defense-in-depth
// reason, with no behavior change for any currently-active session.
export async function allowedProjectIdsFor(service: any, session: any): Promise<Set<string> | null> {
  if (hasPermission(session, 'VIEW_ALL_PROJECTS')) return null
  const { data: ids } = await service
    .from('project_members_active')
    .select('project_id')
    .eq('project_workspace_id', session.workspaceId)
    .eq('member_user_id', session.id)
  return new Set((ids || []).map((r: any) => r.project_id))
}

// FIX (section-11 audit, pass 2): the server now says, per request, whether THIS
// viewer can actually decide it. The client used to guess (any role-based step
// showed Approve/Reject to everyone looking at it — including the requester and
// oversight admins who aren't in the role — and every click ended in a 403), and
// the sidebar badge / "My queue" counted requests the viewer could never act on
// (their own, when they held the assigned role).
export function canDecideRequest(r: any, session: any, roleId: string | null | undefined): boolean {
  if (r.status !== 'pending' || r.sending_started_at) return false
  if (!hasPermission(session, 'APPROVE_DOCUMENTS')) return false
  const steps: any[] = r.approval_steps || []
  const step = steps.find(s => s.step_order === r.current_step)
  if (!step || step.status !== 'pending') return false
  const assigned = step.approver_user_id
    ? step.approver_user_id === session.id
    : !!step.approver_role_id && !!roleId && roleId === step.approver_role_id
  if (!assigned) return false
  if (r.requested_by === session.id && !r.allow_self_approval) return false
  if (r.require_distinct_approvers && steps.some(s => s.status === 'approved' && s.decided_by === session.id)) return false
  return true
}

export function decorate(requests: any[], session: any, roleId: string | null | undefined) {
  const canSeeMoney = hasPermission(session, 'VIEW_FINANCIALS')
  return requests.map(r => {
    const canDecide = canDecideRequest(r, session, roleId)
    // FIX (section-11 audit, pass 2): amounts in an approval's snapshot were
    // shown to anyone who could list the request — including members whose role
    // deliberately lacks VIEW_FINANCIALS (the seeded Project Coordinator holds
    // VIEW_ALL_PROJECTS but not VIEW_FINANCIALS). An approver needs the figure
    // to decide, and the requester already knows it, so they keep it.
    const keepAmount = canSeeMoney || canDecide || r.requested_by === session.id
    const context = keepAmount ? r.context : { ...(r.context || {}), amount: null }
    // decided_by is only needed server-side for canDecide.
    const approval_steps = (r.approval_steps || []).map((s: any) => {
      const { decided_by, ...rest } = s
      return rest
    })
    return { ...r, context, approval_steps, canDecide }
  })
}
