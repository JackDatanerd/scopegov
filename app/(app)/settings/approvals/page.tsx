// app/(app)/settings/approvals/page.tsx
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import ApprovalWorkflowsClient from '@/components/settings/ApprovalWorkflowsClient'

export const metadata = { title: 'Approval Workflows' }

export default async function ApprovalWorkflowsPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
    return (
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="page-hd">
          <div>
            <h1 className="page-title">Approval Workflows</h1>
            <p className="page-sub">Configure who signs off on SOWs and change orders before they reach a client</p>
          </div>
        </div>
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-lock empty-state-icon" />
            <p className="empty-state-title">You don&rsquo;t have access to this page</p>
            <p className="empty-state-sub">Workflow configuration is limited to members who can manage workspace settings.</p>
          </div>
        </div>
      </div>
    )
  }

  const service = createServiceClient()

  const [workflowsRes, rolesRes, membersRes] = await Promise.all([
    (service as any)
      .from('approval_workflows')
      .select(`
        id, document_type, name, threshold_amount, threshold_currency, is_active, created_at,
        approval_workflow_steps(id, step_order, approver_role_id, approver_user_id,
          roles(id, name),
          user:users!approval_workflow_steps_approver_user_id_fkey(id, name, email))
      `)
      .eq('workspace_id', session.workspaceId)
      .order('document_type', { ascending: true }),
    (service as any)
      .from('roles')
      .select('id, name')
      .eq('workspace_id', session.workspaceId)
      .order('name'),
    (service as any)
      .from('workspace_members')
      .select('id, users!workspace_members_user_id_fkey(id, name, email)')
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active'),
  ])

  const workflows = workflowsRes.data || []
  const roles     = rolesRes.data || []
  const members   = (membersRes.data || [])
    .filter((m: any) => m.users)
    .map((m: any) => ({ id: m.users.id, name: m.users.name, email: m.users.email }))

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-hd">
        <div>
          <div style={{ marginBottom: 6 }}>
            <Link href="/settings" style={{ fontSize: 12, color: 'var(--text-3)' }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Settings
            </Link>
          </div>
          <h1 className="page-title">Approval Workflows</h1>
          <p className="page-sub">Configure who signs off on SOWs and change orders before they reach a client</p>
        </div>
        <Link href="/approvals">
          <button className="btn btn-ghost btn-sm"><i className="ti ti-shield-check" style={{ fontSize: 12 }} /> View queue</button>
        </Link>
      </div>

      <ApprovalWorkflowsClient
        initialWorkflows={workflows}
        roles={roles}
        members={members}
      />
    </div>
  )
}
