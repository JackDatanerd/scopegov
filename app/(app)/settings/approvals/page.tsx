// app/(app)/settings/approvals/page.tsx
import { getSessionStrict, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import ApprovalWorkflowsClient from '@/components/settings/ApprovalWorkflowsClient'
import { fetchPaged } from '@/lib/utils/paginate'

export const metadata = { title: 'Approval Workflows' }

export default async function ApprovalWorkflowsPage() {
  const session = await getSessionStrict()
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
    // FIX (Settings independent pass 7): this was `.limit(5000)`, but PostgREST silently caps a read at its Max Rows
    // setting (1000 by default), so past ~1000 projects a currency that only appears later was missing from the
    // "these currencies won't be gated" warning. Paged, like the audit page's project list. Failure is tolerated
    // (the warning is advisory) and keeps the { data, error } shape the code below reads.
    fetchPaged<any>(
      (f, t) => (service as any)
        .from('projects')
        .select('id, currency', { count: 'exact' })
        .eq('workspace_id', session.workspaceId)
        .is('deleted_at', null)
        .order('id')
        .range(f, t),
      { maxRows: 50000 },
    ).then(r => ({ data: r.rows as any[], error: null as any }))
     .catch(error => ({ data: null as any[] | null, error })),
  ])

  // FIX (Settings independent pass 5 — B2): none of these reads' errors were checked, so a failed workflows
  // read rendered as "No approval rules — they send immediately", and an admin who believed it created
  // duplicate rules (or switched real ones off). A failed read is shown as a failure. The roles and members
  // lists feed every step's picker and the "nobody can approve" warnings, so they count too. The currency and
  // project-currency reads only drive defaults and a warning, so they are logged and tolerated.
  const failed = [
    ['workflows', workflowsRes], ['roles', rolesRes], ['members', membersRes],
  ].filter(([, r]: any) => r.error)
  if (failed.length > 0) {
    for (const [name, r] of failed as any[]) console.error(`Approval workflows: failed to load ${name}`, r.error)
    return (
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="page-hd">
          <div>
            <div style={{ marginBottom: 6 }}>
              <Link href="/settings" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Settings
              </Link>
            </div>
            <h1 className="page-title">Approval Workflows</h1>
          </div>
        </div>
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-alert-triangle empty-state-icon" />
            <p className="empty-state-title">Couldn&rsquo;t load your approval workflows</p>
            <p className="empty-state-sub">Nothing has been changed. Reload the page to try again before creating or editing a rule.</p>
            <Link href="/settings/approvals"><button className="btn btn-ghost btn-sm">Try again</button></Link>
          </div>
        </div>
      </div>
    )
  }
  if (wsRes.error) console.error('Approval workflows: failed to load workspace currency', wsRes.error)
  if (projectCurrenciesRes.error) console.error('Approval workflows: failed to load project currencies', projectCurrenciesRes.error)

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
        workspaceId={session.workspaceId}
        projectCurrencies={projectCurrencies}
      />
    </div>
  )
}
