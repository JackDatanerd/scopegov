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
            <p className="page-sub">Configure who signs off on SOWs, change orders and invoices before they reach a client</p>
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

  const [workflowsRes, rolesRes, membersRes, wsRes, projectCurrenciesRes] = await Promise.all([
    (service as any)
      .from('approval_workflows')
      .select(`
        id, document_type, name, threshold_amount, threshold_currency, is_active, created_at,
        allow_self_approval, require_distinct_approvers, apply_to_other_currencies,
        approval_workflow_steps(id, step_order, approver_role_id, approver_user_id,
          roles(id, name),
          user:users!approval_workflow_steps_approver_user_id_fkey(id, name, email))
      `)
      .eq('workspace_id', session.workspaceId)
      .order('document_type', { ascending: true }),
    // FIX (section-11 audit, flagship finding): this used to list every
    // role in the workspace with no permission filter — including ones
    // that don't carry APPROVE_DOCUMENTS at all (e.g. "Designer"), which
    // is how a dead-end step could get assigned in the first place. Keep
    // fetching `permissions` so the client can flag ineligible roles —
    // deliberately NOT filtering the query itself: an existing, already-
    // broken step (assigned before this fix, or made ineligible after
    // its role's permissions changed) still needs to render its real
    // selected value in the edit form. Filtering it out of the options
    // list here would reproduce the exact "selected value disappears
    // from its own dropdown" bug already found and fixed for the
    // currency picker elsewhere — the admin opening this editor
    // specifically to FIX a broken step must see what it's currently set
    // to, not a blank "Select role…".
    (service as any)
      .from('roles')
      .select('id, name, permissions')
      .eq('workspace_id', session.workspaceId)
      .order('name'),
    // FIX (section-11 audit, flagship finding): same reasoning for the
    // named-person picker.
    (service as any)
      .from('workspace_members')
      .select('id, role_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email)')
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active'),
    // FIX (fix round, section-11 finding): the new-workflow threshold
    // currency picker always defaulted to a hardcoded 'USD', regardless
    // of the workspace's actual default currency (never fetched on this
    // page at all) — a non-USD workspace had to remember to change it
    // every single time, with nothing anywhere warning them a forgotten
    // change means the rule silently never matches a document (see
    // migration 023 — threshold_currency is workspace-currency-isolated
    // by design). Fetched here and passed down as the picker's default.
    (service as any)
      .from('workspaces')
      .select('currency')
      .eq('id', session.workspaceId)
      .maybeSingle(),
    // FIX (section-11 audit, pass 2): the currencies projects are ACTUALLY billed in, so
    // the editor can warn when a value threshold would silently leave some of them
    // ungated (a threshold only ever compares documents in its own currency).
    (service as any)
      .from('projects')
      .select('currency')
      .eq('workspace_id', session.workspaceId)
      .is('deleted_at', null)
      .limit(5000),
  ])

  const workflows = workflowsRes.data || []
  const roles     = (rolesRes.data || [])
    .map((r: any) => ({ id: r.id, name: r.name, canApprove: r.permissions?.APPROVE_DOCUMENTS === true }))
  const members   = (membersRes.data || [])
    .filter((m: any) => m.users)
    .map((m: any) => ({ id: m.users.id, name: m.users.name, email: m.users.email, roleId: m.role_id ?? null, canApprove: m.effective_permissions?.APPROVE_DOCUMENTS === true }))
  const workspaceCurrency = wsRes.data?.currency || 'USD'
  const projectCurrencies: string[] = Array.from(new Set<string>((projectCurrenciesRes.data || []).map((p: any) => String(p.currency || '').toUpperCase()).filter(Boolean))).sort()

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
          <p className="page-sub">Configure who signs off on SOWs, change orders and invoices before they reach a client</p>
        </div>
        <Link href="/approvals">
          <button className="btn btn-ghost btn-sm"><i className="ti ti-shield-check" style={{ fontSize: 12 }} /> View queue</button>
        </Link>
      </div>

      <ApprovalWorkflowsClient
        initialWorkflows={workflows}
        roles={roles}
        members={members}
        workspaceCurrency={workspaceCurrency}
        projectCurrencies={projectCurrencies}
      />
    </div>
  )
}
