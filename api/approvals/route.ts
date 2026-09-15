export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

const REQUEST_FIELDS = `
  id, document_type, document_id, project_id, status, current_step, total_steps,
  context, created_at, decided_at, requested_by,
  requester:users!approval_requests_requested_by_fkey(id, name, email),
  projects(id, name),
  approval_steps(
    id, step_order, status, note, decided_at,
    approver_role_id, approver_user_id,
    roles(id, name),
    approver:users!approval_steps_approver_user_id_fkey(id, name),
    decider:users!approval_steps_decided_by_fkey(id, name)
  )
`

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    const scope = request.nextUrl.searchParams.get('scope') || 'mine'

    // Workspace-wide view — everything, any status, for oversight. Gated
    // behind the same permission distinction Phase 2's portfolio report
    // uses (VIEW_ALL_PROJECTS), or MANAGE_WORKSPACE_SETTINGS since that's
    // who configures the workflows in the first place.
    if (scope === 'all') {
      if (!hasPermission(session, 'VIEW_ALL_PROJECTS') && !hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
        return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

      const { data } = await (service as any)
        .from('approval_requests')
        .select(REQUEST_FIELDS)
        .eq('workspace_id', session.workspaceId)
        .order('created_at', { ascending: false })
        .limit(500)

      return NextResponse.json({ requests: data || [], scope: 'all' })
    }

    // "Mine" — pending requests whose CURRENT step is assigned to me,
    // either by name or via a role I currently hold. Filtered in JS
    // (rather than in the query) because "the pending step" is the one
    // whose step_order matches the request's current_step, which isn't
    // expressible as a single PostgREST filter across the join.
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('role_id')
      .eq('workspace_id', session.workspaceId)
      .eq('user_id', session.id)
      .eq('status', 'active')
      .maybeSingle()

    // FIX (re-audit): 150 pending requests workspace-wide, fetched
    // oldest-first, before the "assigned to me" filter runs in JS. In a
    // busy workspace with 150+ pending requests across all users, a
    // genuinely-mine request newer than the cutoff would never appear —
    // no warning, the badge and queue would just silently undercount.
    // Match the 500 cap used elsewhere in the app (e.g. the SOW registry)
    // rather than a much tighter one specific to this endpoint.
    const { data: pending } = await (service as any)
      .from('approval_requests')
      .select(REQUEST_FIELDS)
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(500)

    const mine = (pending || []).filter((r: any) => {
      const step = (r.approval_steps || []).find((s: any) => s.step_order === r.current_step)
      if (!step) return false
      if (step.approver_user_id) return step.approver_user_id === session.id
      if (step.approver_role_id) return member?.role_id === step.approver_role_id
      return false
    })

    return NextResponse.json({ requests: mine, scope: 'mine' })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
