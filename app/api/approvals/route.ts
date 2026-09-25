export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { healStuckSends } from '@/lib/approvals/engine'
import { fetchAll } from '@/lib/utils/fetch-all'

const REQUEST_FIELDS = `
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

const STATUS_FILTERS = new Set(['pending', 'approved', 'rejected', 'cancelled'])
const TYPE_FILTERS   = new Set(['sow', 'co', 'co_counter', 'invoice'])

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
async function allowedProjectIdsFor(service: any, session: any): Promise<Set<string> | null> {
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
function canDecideRequest(r: any, session: any, roleId: string | null | undefined): boolean {
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

function decorate(requests: any[], session: any, roleId: string | null | undefined) {
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

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    const params = request.nextUrl.searchParams
    const scope = params.get('scope') || 'mine'
    const statusFilter = params.get('status') || ''
    const typeFilter = params.get('type') || ''
    if (statusFilter && !STATUS_FILTERS.has(statusFilter))
      return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 })
    if (typeFilter && !TYPE_FILTERS.has(typeFilter))
      return NextResponse.json({ error: 'Invalid type filter' }, { status: 400 })

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('role_id')
      .eq('workspace_id', session.workspaceId)
      .eq('user_id', session.id)
      .eq('status', 'active')
      .maybeSingle()
    const roleId: string | null = member?.role_id ?? null

    // FIX (independent pass 3): lazy self-heal — see healStuckSends' own
    // comment in lib/approvals/engine.ts. Scoped to this session's workspace
    // only, so a busy Approvals page doesn't turn into a cross-workspace
    // table scan on every load. Best-effort: a failure here must never break
    // the list itself.
    try { await healStuckSends(service, 10, session.workspaceId) } catch (e) { console.error('lazy healStuckSends failed:', e) }

    // Workspace-wide view — everything, any status, for oversight. Gated
    // behind VIEW_ALL_PROJECTS, or MANAGE_WORKSPACE_SETTINGS since that's who
    // configures the workflows in the first place.
    if (scope === 'all') {
      if (!hasPermission(session, 'VIEW_ALL_PROJECTS') && !hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
        return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

      // FIX (section-11 audit, independent pass 4): this used a bare
      // .limit(500) with no truncation detection — the exact class of bug
      // already fixed everywhere else "big reads" happen in this codebase
      // (portfolio-data.ts, scope-health.ts, the invoice registry/export).
      // A workspace with more than 500 approval_requests (across every
      // status/type, since this is the oversight view with no default
      // status filter) silently dropped the oldest ones past the cap with
      // no signal to the viewer. fetchAll pages through all of them (up to
      // its safety ceiling), same as the invoice registry's own ledger read.
      const rows = await fetchAll<any>('approvals list (all)', (from, to) => {
        let q = (service as any)
          .from('approval_requests')
          .select(REQUEST_FIELDS)
          .eq('workspace_id', session.workspaceId)
        if (statusFilter) q = q.eq('status', statusFilter)
        if (typeFilter) q = q.eq('document_type', typeFilter)
        return q.order('created_at', { ascending: false }).order('id').range(from, to)
      })

      // FIX (section-11 audit, pass 2): MANAGE_WORKSPACE_SETTINGS alone (no
      // VIEW_ALL_PROJECTS) used to return every project's requests — titles,
      // project names, amounts — for projects the viewer can't open. Every
      // other route treats canReadProject as the visibility boundary; the
      // oversight list now does too.
      const allowed = await allowedProjectIdsFor(service, session)
      const visible = rows.filter((r: any) => !allowed || allowed.has(r.project_id))
      return NextResponse.json({ requests: decorate(visible, session, roleId), scope: 'all' })
    }

    // The ORIGINAL REQUESTER's own submissions — pending, decided or send-failed.
    // Scoped strictly to the caller's own requests; requested_by = session.id
    // is inherently "yours to see". The Approvals page now shows this as a tab
    // ("My requests") for everyone, not only as the retry banner.
    if (scope === 'submitted') {
      // FIX (section-11 audit, independent pass 4): same bare-.limit(200)-with-
      // no-truncation-signal gap as the 'all' scope above — a heavy submitter
      // (or one with a lot of decided/rejected history, since this scope has
      // no default status filter) could have their oldest own requests drop
      // off "My requests" with nothing to indicate anything was cut.
      const rows = await fetchAll<any>('approvals list (submitted)', (from, to) => {
        let q = (service as any)
          .from('approval_requests')
          .select(REQUEST_FIELDS)
          .eq('workspace_id', session.workspaceId)
          .eq('requested_by', session.id)
        if (statusFilter) q = q.eq('status', statusFilter)
        if (typeFilter) q = q.eq('document_type', typeFilter)
        return q.order('created_at', { ascending: false }).order('id').range(from, to)
      })
      return NextResponse.json({ requests: decorate(rows, session, roleId), scope: 'submitted' })
    }

    // "Mine" — pending requests whose CURRENT step this viewer can decide.
    // Filtered in JS because "the pending step" is the one whose step_order
    // matches the request's current_step, which isn't expressible as a single
    // PostgREST filter across the join.
    // FIX (section-11 audit, independent pass 4): this used a bare .limit(500)
    // ordered created_at ASCENDING — the worst version of the truncation bug
    // above, since ascending order means it's the OLDEST 500 pending requests
    // that get kept and every NEWER one silently dropped once a workspace
    // passes 500 pending requests workspace-wide (this query has no status
    // filter beyond 'pending', so it's every pending request of every type,
    // not just what a given viewer can act on). A brand-new approval assigned
    // to someone could never appear in "My queue" or the sidebar badge at all
    // until 500 older ones clear — exactly backwards from what a live alert
    // queue needs. fetchAll removes the cap (up to its own safety ceiling).
    const pending = await fetchAll<any>('approvals list (mine, pending)', (from, to) =>
      (service as any)
        .from('approval_requests')
        .select(REQUEST_FIELDS)
        .eq('workspace_id', session.workspaceId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .order('id')
        .range(from, to)
    )

    // A project-restricted VIEW_OWN_PROJECTS member isn't exempt just because
    // they hold the assigned role, or are the named approver, on a document
    // outside their project access (same rule as notifyStepApprovers and the
    // decision route).
    const allowed = await allowedProjectIdsFor(service, session)
    const mine = pending.filter((r: any) => {
      if (allowed && !allowed.has(r.project_id)) return false
      return canDecideRequest(r, session, roleId)
    })

    return NextResponse.json({ requests: decorate(mine, session, roleId), scope: 'mine' })
  } catch (err) {
    console.error('Approvals list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
