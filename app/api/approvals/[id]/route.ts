export const runtime = 'nodejs'

import { isUuidString } from '@/lib/utils/uuid'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { REQUEST_FIELDS, decorate } from '@/lib/approvals/list'

// FEATURE (section-11 audit, pass 1 — G1): one approval request, by id.
//
// Every notification and email deep-links to /approvals?highlight=<id>, but the page could only find that
// request by downloading the viewer's lists and searching them. A role-based step notifies everyone holding
// the role, so when a colleague decides first the request is no longer in a non-admin approver's "My queue" —
// and it is not theirs under "My requests" either — so the link opened an empty page with no explanation.
// This route lets the page open the request directly and show what happened to it ("Approved by …",
// "Cancelled").
//
// Who may read one — the same people who could already see it somewhere in the product:
//   * the requester;
//   * anyone currently or formerly involved in a step (assigned by name, holding the assigned role, or
//     having decided a step);
//   * oversight (VIEW_ALL_PROJECTS or MANAGE_WORKSPACE_SETTINGS).
// Everyone except the requester must also be able to read the project the document lives on, exactly like
// the list, decision, cancel and reassign paths. Anything else is a 404 — a request you may not see is
// indistinguishable from one that does not exist.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const service = createServiceClient()
    const { data: row, error } = await (service as any)
      .from('approval_requests')
      .select(REQUEST_FIELDS)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()
    if (error) {
      console.error('Approval request GET failed:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    const notFound = () => NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
    if (!row) return notFound()

    const { data: member, error: memberErr } = await (service as any)
      .from('workspace_members').select('role_id')
      .eq('workspace_id', session.workspaceId).eq('user_id', session.id).eq('status', 'active')
      .maybeSingle()
    // FIX (approvals pass, B3): a failed read left roleId = null, so a role-assigned approver was told 404 "not found"
    // for a request that was theirs.
    if (memberErr) {
      console.error('Approval request GET: member lookup failed:', memberErr)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    const roleId: string | null = member?.role_id ?? null

    const isRequester = row.requested_by === session.id
    if (!isRequester) {
      const involved = (row.approval_steps || []).some((s: any) =>
        s.approver_user_id === session.id ||
        s.decided_by === session.id ||
        (!!roleId && s.approver_role_id === roleId))
      const oversight = hasPermission(session, 'VIEW_ALL_PROJECTS') || hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')
      if (!involved && !oversight) return notFound()
      if (!(await canReadProject(service, session, row.project_id))) return notFound()
    }

    const [decorated] = decorate([row], session, roleId)
    return NextResponse.json({ request: decorated })
  } catch (err) {
    console.error('Approval request GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
