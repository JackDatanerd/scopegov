export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { listApproverCandidates } from '@/lib/approvals/eligibility'
import { canReadProject } from '@/lib/utils/project-access'

// Candidates for reassigning a pending step: people who could actually decide
// this request (Approve documents permission + access to the project, not the
// requester unless the workflow allows self-approval) and roles that carry the
// permission. Workspace admins only — it exists to feed the reassign control.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: req, error: reqErr } = await (service as any)
      .from('approval_requests').select('id, project_id, requested_by, allow_self_approval')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    // FIX (approvals pass 14): a failed read answered 404 "not found" (.single() with `error` unread).
    if (reqErr) {
      console.error('Approval approvers: request lookup failed:', reqErr)
      return NextResponse.json({ error: 'Could not load this approval request — please try again.' }, { status: 500 })
    }
    if (!req) return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
    if (!(await canReadProject(service, session, req.project_id)))
      return NextResponse.json({ error: 'You do not have access to this project' }, { status: 403 })

    let users = await listApproverCandidates(service, session.workspaceId, req.project_id)
    if (req.allow_self_approval !== true) users = users.filter(u => u.id !== req.requested_by)

    const { data: roles, error: rolesErr } = await (service as any)
      .from('roles').select('id, name, permissions')
      .eq('workspace_id', session.workspaceId).order('name')
    // FIX (approvals pass 14): a failed read produced an empty role list, so the picker silently offered no roles.
    if (rolesErr) {
      console.error('Approval approvers: roles lookup failed:', rolesErr)
      return NextResponse.json({ error: 'Could not load approvers — please try again.' }, { status: 500 })
    }
    const approverRoles = (roles || [])
      .filter((r: any) => r.permissions?.APPROVE_DOCUMENTS === true)
      .map((r: any) => ({ id: r.id, name: r.name }))

    return NextResponse.json({ users: users.map(u => ({ id: u.id, name: u.name, email: u.email })), roles: approverRoles })
  } catch (err) {
    console.error('Approval approvers error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
